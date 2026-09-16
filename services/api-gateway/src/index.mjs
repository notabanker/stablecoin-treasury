import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticateUser, checkLoginRateLimit, clearAuthCookieHeaders, clearLoginFailures, createSession,
  csrfCookieHeader, destroySession, emitSecurityAudit, recordLoginFailure,
  requireAuth, requireAuthWithCsrf, requirePermission, resolveUserByEmail, sessionCookieHeader,
  sessionTokenFromCookie
} from "../../../packages/shared/auth.mjs";
import { isDemoResetAllowed, validateProductionConfig } from "../../../packages/shared/config.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { ratesToEur } from "../../../packages/shared/policy-math.mjs";
import { serviceGet, servicePost, serviceUrls } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { processWebhook, webhookMetrics } from "./webhooks.mjs";

const port = Number(process.env.GATEWAY_PORT || process.env.PORT || 8080);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = resolve(projectRoot, "apps/web");
const PAYMENT_MUTATION_TIMEOUT_MS = Number(process.env.PAYMENT_MUTATION_TIMEOUT_MS || 10000);

validateProductionConfig("api-gateway");

const perm = (permission) => (handler) => requirePermission(permission)(handler);
const paymentPerm = (action) => perm(`payment:${action}`);

// The gateway's state view: every domain read, fetched in parallel. Individual service
// failures degrade that slice (empty collection + `degraded` entry) instead of failing the
// whole response, so one down service cannot blank the dashboard.
const STATE_SERVICES = [
  ["entities", "wallet", "/entities"],
  ["assets", "wallet", "/assets"],
  ["wallets", "wallet", "/wallets"],
  ["counterparties", "compliance", "/counterparties"],
  ["policies", "policy", "/policies"],
  ["payments", "payment", "/payments"],
  ["journalEntries", "accounting", "/journals"],
  ["reconciliation", "reconciliation", "/reconciliation"],
  ["providers", "operations", "/providers"],
  ["audit", "operations", "/audit"],
  ["alerts", "operations", "/alerts"],
  ["repair", "payment", "/repair"]
];

// Forward a payment command and return its result alongside fresh state.
const paymentCommand = (action) => paymentPerm(action)(async (ctx) => {
  const result = await servicePost("payment", `/payments/${ctx.params.id}/${action}`, {}, paymentMutationOptions(ctx));
  return ok({ ...result, state: await composeState(ctx) });
});

const routes = [
  route("GET", "/health", () => ok({ status: "ok", service: "api-gateway" })),
  route("GET", "/ready", async () => ok(await readiness())),
  route("GET", "/api/docs", () => ok(apiDocs())),
  route("GET", "/api/state", requireAuth(async (ctx) => ok(await composeState(ctx)))),
  route("POST", "/api/login", async (ctx) => {
    const result = await login(ctx.body, ctx);
    return { status: 200, body: result.body, cookies: result.cookies };
  }),
  route("POST", "/api/logout", requireAuthWithCsrf(async (ctx) => {
    const result = await logout(ctx);
    return { status: 200, body: { message: result.message }, cookies: result.cookies };
  })),
  route("POST", "/api/reset", perm("admin:reset")(async (ctx) => {
    if (!isDemoResetAllowed()) {
      throw httpError(403, "Demo reset is disabled in production. Set ALLOW_DEMO_RESET=true to enable.", "demo_reset_disabled");
    }
    const options = tenantOptions(ctx);
    await Promise.all([
      servicePost("wallet", "/reset", {}, options),
      servicePost("policy", "/reset", {}, options),
      servicePost("compliance", "/reset", {}, options),
      servicePost("payment", "/reset", {}, options),
      servicePost("accounting", "/reset", {}, options),
      servicePost("reconciliation", "/reset", {}, options),
      servicePost("operations", "/reset", {}, options)
    ]);
    return ok({ state: await composeState(ctx) });
  })),
  route("POST", "/api/payments", paymentPerm("create")(async (ctx) => {
    const idempotencyKey = ctx.headers["idempotency-key"];
    if (!idempotencyKey) {
      throw httpError(400, "Idempotency-Key required", "idempotency_key_required");
    }
    const result = await servicePost("payment", "/payments", ctx.body, {
      ...paymentMutationOptions(ctx),
      idempotencyKey
    });
    return ok({ ...result, state: await composeState(ctx) });
  })),
  route("POST", "/api/payments/:id/approve", paymentCommand("approve")),
  route("POST", "/api/payments/:id/execute", paymentCommand("execute")),
  route("POST", "/api/payments/:id/cancel", paymentCommand("cancel")),
  route("GET", "/api/payments/:id/attempts", paymentPerm("read")(requireAuth(async (ctx) =>
    ok({ attempts: await serviceGet("payment", `/payments/${ctx.params.id}/attempts`, tenantOptions(ctx)) })))),
  route("GET", "/api/payments/:id/approvals", paymentPerm("read")(requireAuth(async (ctx) =>
    ok(await serviceGet("payment", `/payments/${ctx.params.id}/approvals`, tenantOptions(ctx)))))),
  route("POST", "/api/policies", perm("policy:update")(async (ctx) => {
    await servicePost("policy", "/policies", ctx.body, tenantOptions(ctx));
    await recordAudit(ctx, "Policy updated", "Payment controls", "Thresholds changed through gateway");
    return ok({ state: await composeState(ctx) });
  })),
  route("POST", "/api/policies/assets/:assetId", perm("policy:update")(async (ctx) => {
    await servicePost("policy", `/policies/assets/${ctx.params.assetId}`, ctx.body, tenantOptions(ctx));
    await recordAudit(ctx, "Asset policy changed", ctx.params.assetId, ctx.body.enabled ? "Asset allowed" : "Asset removed from allowlist");
    return ok({ state: await composeState(ctx) });
  })),
  route("POST", "/api/reconciliation/:id/resolve", perm("reconciliation:resolve")(async (ctx) => {
    const result = await servicePost("reconciliation", `/reconciliation/${ctx.params.id}/resolve`, {}, tenantOptions(ctx));
    await recordAudit(ctx, "Reconciliation resolved", ctx.params.id, result.issue);
    return ok({ ...result, state: await composeState(ctx) });
  })),
  route("POST", "/api/reconciliation/exceptions/simulate", perm("reconciliation:simulate")(async (ctx) => {
    const payments = await serviceGet("payment", "/payments", tenantOptions(ctx));
    const payment = payments.find((item) => item.status === "Settled") || payments[0];
    const result = await servicePost("reconciliation", "/reconciliation/exceptions/simulate", { payment }, tenantOptions(ctx));
    await recordAudit(ctx, "Exception opened", payment.reference, result.issue, ctx?.user?.displayName || "Reconciliation engine");
    return ok({ ...result, state: await composeState(ctx) });
  })),
  route("POST", "/api/operations/providers/:id/toggle", perm("operations:toggle_provider")(async (ctx) => {
    const provider = await servicePost("operations", `/providers/${ctx.params.id}/toggle`, { actor: ctx.user?.displayName || "System" }, tenantOptions(ctx));
    return ok({ provider, state: await composeState(ctx) });
  })),
  route("POST", "/api/operations/incidents/simulate", perm("operations:simulate_incident")(async (ctx) => {
    const result = await servicePost("operations", "/incidents/simulate", {}, tenantOptions(ctx));
    return ok({ ...result, state: await composeState(ctx) });
  })),
  route("POST", "/api/accounting/export", perm("accounting:export")(async (ctx) => {
    await servicePost("accounting", "/journals/export", {}, tenantOptions(ctx));
    await recordAudit(ctx, "Journal export created", "Accounting", "Journal lines marked exported");
    return ok({ state: await composeState(ctx) });
  })),
  route("GET", "/api/repair", paymentPerm("execute")(requireAuth(async (ctx) =>
    ok(await serviceGet("payment", "/repair", tenantOptions(ctx)))))),
  route("POST", "/api/repair/:id/retry", paymentPerm("execute")(async (ctx) => {
    const result = await servicePost("payment", `/repair/${ctx.params.id}/retry`, {}, tenantOptions(ctx));
    return ok({ ...result, state: await composeState(ctx) });
  })),
  // Webhook ingestion (V3.7)
  route("POST", "/api/webhooks/:providerId", async ({ params, body, rawBody, headers }) => {
    const signature = headers["x-webhook-signature"] || "";
    return ok(await processWebhook(params.providerId, body, rawBody, signature));
  })
];

createJsonService({
  name: "api-gateway",
  port,
  staticRoot: webRoot,
  extraMetrics: () => ({
    webhookSignatureFailures: webhookMetrics.signatureFailures,
    webhooksProcessed: webhookMetrics.processed,
    webhookDuplicates: webhookMetrics.duplicates
  }),
  routes
});

async function login(body, ctx) {
  const { email, password } = body;
  if (!email || !password) {
    throw httpError(422, "Email and password are required", "missing_credentials");
  }

  const ip = ctx?.clientIp || "127.0.0.1";
  // Resolve tenant for audit events before the credential check (does not leak existence).
  const auditTenant = (await resolveUserByEmail(email))?.tenant_id || DEFAULT_TENANT_ID;

  const rateCheck = checkLoginRateLimit(ip, email);
  if (!rateCheck.allowed) {
    await emitSecurityAudit({ actor: email, action: "Login lockout", object: ip, detail: "Rate limited after too many failures", tenantId: auditTenant });
    throw httpError(429, "Too many failed login attempts. Try again later.", "login_rate_limited");
  }

  const user = await authenticateUser(email, password);
  if (!user) {
    const result = recordLoginFailure(ip, email);
    await emitSecurityAudit({ actor: email, action: "Login failed", object: ip, detail: result.lockedOut ? "Account locked out" : `Failed attempt ${result.failures}`, tenantId: auditTenant });
    if (result.lockedOut) {
      throw httpError(429, "Too many failed login attempts. Account temporarily locked.", "login_rate_limited");
    }
    throw httpError(401, "Invalid email or password", "invalid_credentials");
  }

  clearLoginFailures(ip, email);
  await emitSecurityAudit({ actor: user.displayName, action: "Login success", object: user.email, detail: `Successful login from ${ip}`, tenantId: user.tenantId });

  // Session rotation: destroy any session the client already presented to prevent fixation.
  const oldSessionToken = sessionTokenFromCookie(ctx?.headers?.cookie);
  if (oldSessionToken) await destroySession(oldSessionToken);

  const session = await createSession(user.id, user.tenantId);
  // Q7 / V6 M1: default browser login is cookie-only — the session token stays out of JSON
  // where XSS can read it. API clients (integration tests, scripts) opt in with client:"api".
  const includeBearerToken = body?.client === "api" || body?.includeSessionToken === true;
  return {
    body: {
      user: { id: user.id, email: user.email, displayName: user.displayName, tenantId: user.tenantId, roles: user.roles },
      session: {
        ...(includeBearerToken ? { token: session.token } : {}),
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt
      },
      message: "Login successful"
    },
    cookies: [
      sessionCookieHeader(session.token, session.expiresAt),
      csrfCookieHeader(session.csrfToken, session.expiresAt)
    ]
  };
}

async function logout(ctx) {
  if (ctx.user?.sessionToken) {
    await destroySession(ctx.user.sessionToken);
    await emitSecurityAudit({
      actor: ctx.user.displayName || "unknown",
      action: "Logout",
      object: ctx.user.email || "unknown",
      detail: "Session terminated",
      tenantId: ctx.tenantId || ctx.user.tenantId || DEFAULT_TENANT_ID
    });
  }
  return { message: "Logged out", cookies: clearAuthCookieHeaders() };
}

async function composeState(ctx) {
  const options = tenantOptions(ctx);
  const results = await Promise.allSettled(
    STATE_SERVICES.map(([, service, path]) => serviceGet(service, path, options))
  );

  const state = { degraded: [] };
  STATE_SERVICES.forEach(([key, service], index) => {
    if (results[index].status === "fulfilled") {
      state[key] = results[index].value;
    } else {
      state[key] = key === "policies" ? {} : [];
      state.degraded.push(service);
    }
  });

  return {
    ...state,
    currentUser: currentUserShape(ctx),
    lastUpdated: new Date().toISOString(),
    ratesToEur,
    selectedPaymentId: state.payments?.[0]?.id || ""
  };
}

function currentUserShape(ctx) {
  if (!ctx?.user) {
    return { id: "anon", name: "Guest", role: "Unauthenticated" };
  }
  return {
    id: ctx.user.userId,
    name: ctx.user.displayName,
    email: ctx.user.email,
    role: ctx.user.roles?.[0] || ctx.user.role || "User",
    roles: ctx.user.roles || [],
    tenantId: ctx.tenantId || ctx.user.tenantId
  };
}

function recordAudit(ctx, action, object, detail, actor) {
  return servicePost("operations", "/audit", {
    actor: actor || ctx.user?.displayName || "System",
    action,
    object,
    detail
  }, tenantOptions(ctx));
}

function tenantOptions(ctx, extra = {}) {
  return {
    ...extra,
    requestId: ctx?.requestId,
    tenantId: ctx?.tenantId || ctx?.user?.tenantId,
    actingUser: ctx?.user?.userId
      ? { id: ctx.user.userId, display: ctx.user.displayName || "Unknown" }
      : undefined
  };
}

function paymentMutationOptions(ctx) {
  return tenantOptions(ctx, { timeoutMs: PAYMENT_MUTATION_TIMEOUT_MS });
}

async function readiness() {
  const entries = await Promise.all(
    Object.keys(serviceUrls).map(async (service) => {
      try {
        const result = await serviceGet(service, "/health");
        return [service, result.status || "ok"];
      } catch {
        return [service, "down"];
      }
    })
  );
  return Object.fromEntries(entries);
}

function apiDocs() {
  return {
    name: "Corporate Stablecoin Treasury API Gateway",
    pattern: "BFF gateway composing independently deployable domain services",
    services: serviceUrls,
    endpoints: routes.map(({ method, pattern }) => `${method} ${pattern}`)
  };
}
