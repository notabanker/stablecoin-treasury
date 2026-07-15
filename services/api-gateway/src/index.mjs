import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ratesToEur } from "../../../packages/shared/data.mjs";
import { authenticateUser, checkLoginRateLimit, clearLoginFailures, createSession, csrfCookieHeader, destroySession, emitSecurityAudit, recordLoginFailure, requireAuth, requireAuthWithCsrf, requirePermission, resolveUserByEmail, sessionCookieHeader, sessionCookieName, csrfCookieName } from "../../../packages/shared/auth.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { serviceGet, servicePost, serviceUrls } from "../../../packages/shared/service-client.mjs";
import { validateProductionConfig, isDemoResetAllowed } from "../../../packages/shared/config.mjs";
import { processWebhook, webhookMetrics } from "./webhooks.mjs";

const port = Number(process.env.GATEWAY_PORT || process.env.PORT || 8080);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = resolve(projectRoot, "apps/web");
const PAYMENT_MUTATION_TIMEOUT_MS = Number(process.env.PAYMENT_MUTATION_TIMEOUT_MS || 10000);

validateProductionConfig("api-gateway");

const guard = (handler) => requireAuth(handler);
const perm = (permission) => (handler) => requirePermission(permission)(handler);
const paymentPerm = (perm) => (handler) => requirePermission(`payment:${perm}`)(handler);

createJsonService({
  name: "api-gateway",
  port,
  staticRoot: webRoot,
  extraMetrics: () => ({
    webhookSignatureFailures: webhookMetrics.signatureFailures,
    webhooksProcessed: webhookMetrics.processed,
    webhookDuplicates: webhookMetrics.duplicates
  }),
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "api-gateway" })),
    route("GET", "/ready", async () => ok(await readiness())),
    route("GET", "/api/docs", () => ok(apiDocs())),
    route("GET", "/api/state", guard(async (ctx) => ok(await composeState(ctx)))),
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
      return ok({ state: await composeStateSafe(ctx) });
      })),
    route("POST", "/api/payments", paymentPerm("create")(async (ctx) => {
      const result = await servicePost("payment", "/payments", ctx.body, {
        ...paymentMutationOptions(ctx),
        idempotencyKey: ctx.headers["idempotency-key"] || randomUUID()
      });
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/payments/:id/approve", paymentPerm("approve")(async (ctx) => {
      const result = await servicePost("payment", `/payments/${ctx.params.id}/approve`, {}, paymentMutationOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/payments/:id/execute", paymentPerm("execute")(async (ctx) => {
      const result = await servicePost("payment", `/payments/${ctx.params.id}/execute`, {}, paymentMutationOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/payments/:id/cancel", paymentPerm("cancel")(async (ctx) => {
      const result = await servicePost("payment", `/payments/${ctx.params.id}/cancel`, {}, paymentMutationOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("GET", "/api/payments/:id/attempts", guard(async (ctx) => {
      return ok({ attempts: await serviceGet("payment", `/payments/${ctx.params.id}/attempts`, tenantOptions(ctx)) });
    })),
    route("GET", "/api/payments/:id/approvals", guard(async (ctx) => {
      return ok(await serviceGet("payment", `/payments/${ctx.params.id}/approvals`, tenantOptions(ctx)));
    })),
    route("POST", "/api/policies", perm("policy:update")(async (ctx) => {
      await servicePost("policy", "/policies", ctx.body, tenantOptions(ctx));
      await servicePost("operations", "/audit", {
        actor: ctx.user?.displayName || "System",
        action: "Policy updated",
        object: "Payment controls",
        detail: "Thresholds changed through gateway"
      }, tenantOptions(ctx));
      return ok({ state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/policies/assets/:assetId", perm("policy:update")(async (ctx) => {
      await servicePost("policy", `/policies/assets/${ctx.params.assetId}`, ctx.body, tenantOptions(ctx));
      await servicePost("operations", "/audit", {
        actor: ctx.user?.displayName || "System",
        action: "Asset policy changed",
        object: ctx.params.assetId,
        detail: ctx.body.enabled ? "Asset allowed" : "Asset removed from allowlist"
      }, tenantOptions(ctx));
      return ok({ state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/reconciliation/:id/resolve", perm("reconciliation:resolve")(async (ctx) => {
      const result = await servicePost("reconciliation", `/reconciliation/${ctx.params.id}/resolve`, {}, tenantOptions(ctx));
      await servicePost("operations", "/audit", {
        actor: ctx.user?.displayName || "System",
        action: "Reconciliation resolved",
        object: ctx.params.id,
        detail: result.issue
      }, tenantOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/reconciliation/exceptions/simulate", perm("reconciliation:simulate")(async (ctx) => {
      const payments = await serviceGet("payment", "/payments", tenantOptions(ctx));
      const payment = payments.find((item) => item.status === "Settled") || payments[0];
      const result = await servicePost("reconciliation", "/reconciliation/exceptions/simulate", { payment }, tenantOptions(ctx));
      await servicePost("operations", "/audit", {
        actor: ctx?.user?.displayName || "Reconciliation engine",
        action: "Exception opened",
        object: payment.reference,
        detail: result.issue
      }, tenantOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/operations/providers/:id/toggle", perm("operations:toggle_provider")(async (ctx) => {
      const provider = await servicePost("operations", `/providers/${ctx.params.id}/toggle`, { actor: ctx.user?.displayName || "System" }, tenantOptions(ctx));
      return ok({ provider, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/operations/incidents/simulate", perm("operations:simulate_incident")(async (ctx) => {
      const result = await servicePost("operations", "/incidents/simulate", {}, tenantOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    route("POST", "/api/accounting/export", perm("accounting:export")(async (ctx) => {
      await servicePost("accounting", "/journals/export", {}, tenantOptions(ctx));
      await servicePost("operations", "/audit", {
        actor: ctx?.user?.displayName || "System",
        action: "Journal export created",
        object: "Accounting",
        detail: "Journal lines marked exported"
      }, tenantOptions(ctx));
      return ok({ state: await composeStateSafe(ctx) });
    })),
    route("GET", "/api/repair", guard(async (ctx) => {
      return ok(await serviceGet("payment", "/repair", tenantOptions(ctx)));
    })),
    route("POST", "/api/repair/:id/retry", paymentPerm("execute")(async (ctx) => {
      const result = await servicePost("payment", `/repair/${ctx.params.id}/retry`, {}, tenantOptions(ctx));
      return ok({ ...result, state: await composeStateSafe(ctx) });
    })),
    // Webhook ingestion (V3.7)
    route("POST", "/api/webhooks/:providerId", async ({ params, body, headers }) => {
      const signature = headers["x-webhook-signature"] || "";
      const result = await processWebhook(params.providerId, body, signature);
      return ok(result);
    })
  ]
});

async function login(body, ctx) {
  const { email, password } = body;
  if (!email || !password) {
    throw httpError(422, "Email and password are required", "missing_credentials");
  }

  const ip = ctx?.clientIp || "127.0.0.1";

  // Resolve tenant for audit events before credential check (does not leak existence).
  const resolvedUser = await resolveUserByEmail(email);
  const auditTenant = resolvedUser ? resolvedUser.tenant_id : DEFAULT_TENANT_ID;

  // Rate limit check
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

  // Session rotation: if the client presents a valid session cookie, destroy it
  // before issuing a new one to prevent session fixation.
  const oldSessionToken = extractSessionCookie(ctx?.headers);
  if (oldSessionToken) await destroySession(oldSessionToken);

  const session = await createSession(user.id, user.tenantId);
  const cookies = [
    sessionCookieHeader(session.token, session.expiresAt),
    csrfCookieHeader(session.csrfToken, session.expiresAt)
  ];
  return {
    body: {
      user: { id: user.id, email: user.email, displayName: user.displayName, tenantId: user.tenantId, roles: user.roles },
      session: { token: session.token, csrfToken: session.csrfToken, expiresAt: session.expiresAt },
      message: "Login successful"
    },
    cookies
  };
}

function extractSessionCookie(headers) {
  const cookieHeader = headers?.["cookie"];
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:__Host-session|session)=([^;]+)/);
  return match ? match[1] : null;
}

async function logout(ctx) {
  if (ctx.user?.sessionToken) {
    await destroySession(ctx.user.sessionToken);
    await emitSecurityAudit({ actor: ctx.user.displayName || "unknown", action: "Logout", object: ctx.user.email || "unknown", detail: "Session terminated", tenantId: ctx.tenantId || ctx.user.tenantId || DEFAULT_TENANT_ID });
  }
  // Send Max-Age=0 cookies to clear both session and csrf cookies client-side
  const secure = process.env.SESSION_COOKIE_SECURE === "true" ? "; Secure" : "";
  const clearSession = `${sessionCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
  const clearCsrf = `${csrfCookieName()}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  return { message: "Logged out", cookies: [clearSession, clearCsrf] };
}

async function composeState(ctx) {
  const options = tenantOptions(ctx);
  const [
    entities,
    assets,
    wallets,
    counterparties,
    policies,
    payments,
    journalEntries,
    reconciliation,
    providers,
    audit,
    alerts,
    repair
  ] = await Promise.all([
    serviceGet("wallet", "/entities", options),
    serviceGet("wallet", "/assets", options),
    serviceGet("wallet", "/wallets", options),
    serviceGet("compliance", "/counterparties", options),
    serviceGet("policy", "/policies", options),
    serviceGet("payment", "/payments", options),
    serviceGet("accounting", "/journals", options),
    serviceGet("reconciliation", "/reconciliation", options),
    serviceGet("operations", "/providers", options),
    serviceGet("operations", "/audit", options),
    serviceGet("operations", "/alerts", options),
    serviceGet("payment", "/repair", options)
  ]);

  return {
    activeView: "dashboard",
    alerts,
    assets,
    audit,
    counterparties,
    currentUser: ctx?.user ? {
      id: ctx.user.userId,
      name: ctx.user.displayName,
      email: ctx.user.email,
      role: ctx.user.roles?.[0] || ctx.user.role || "User",
      roles: ctx.user.roles || [],
      tenantId: ctx.tenantId || ctx.user.tenantId
    } : {
      id: "anon",
      name: "Guest",
      role: "Unauthenticated"
    },
    entities,
    journalEntries,
    lastUpdated: new Date().toISOString(),
    payments,
    policies,
    providers,
    ratesToEur,
    repair,
    reconciliation,
    selectedPaymentId: payments[0]?.id || "",
    wallets
  };
}

// composeStateSafe tolerates individual downstream failures — if one service is down the
// response still includes available data plus a `degraded` array flagging which services
// couldn't be reached. Mutations return command results immediately; state is optional.
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

async function composeStateSafe(ctx) {
  const options = tenantOptions(ctx);
  const results = await Promise.allSettled(
    STATE_SERVICES.map(([, service, path]) =>
      serviceGet(service, path, options)
    )
  );

  const state = { degraded: [] };
  for (let i = 0; i < STATE_SERVICES.length; i += 1) {
    const key = STATE_SERVICES[i][0];
    const [, service] = STATE_SERVICES[i];
    if (results[i].status === "fulfilled") {
      state[key] = results[i].value;
    } else {
      state[key] = key === "payments" || key === "wallets" ? [] : (key === "policies" ? {} : []);
      state.degraded.push(service);
    }
  }

  return {
    ...state,
    activeView: "dashboard",
    currentUser: ctx?.user ? {
      id: ctx.user.userId,
      name: ctx.user.displayName,
      email: ctx.user.email,
      role: ctx.user.roles?.[0] || "User",
      roles: ctx.user.roles || [],
      tenantId: ctx.tenantId || ctx.user.tenantId
    } : {
      id: "anon",
      name: "Guest",
      role: "Unauthenticated"
    },
    lastUpdated: new Date().toISOString(),
    ratesToEur,
    selectedPaymentId: state.payments?.[0]?.id || ""
  };
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
    Object.entries(serviceUrls).map(async ([service]) => {
      try {
        const result = await serviceGet(service, "/health");
        return [service, result.status || "ok"];
      } catch (error) {
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
    endpoints: [
      "POST /api/login",
      "POST /api/logout",
      "GET /api/state",
      "POST /api/reset",
      "POST /api/payments",
      "POST /api/payments/:id/approve",
      "POST /api/payments/:id/execute",
      "POST /api/payments/:id/cancel",
      "GET /api/payments/:id/attempts",
      "POST /api/policies",
      "POST /api/policies/assets/:assetId",
      "POST /api/reconciliation/:id/resolve",
      "POST /api/reconciliation/exceptions/simulate",
      "POST /api/operations/providers/:id/toggle",
      "POST /api/operations/incidents/simulate",
      "POST /api/accounting/export",
      "GET /api/repair",
      "POST /api/repair/:id/retry",
      "POST /api/webhooks/:providerId"
    ]
  };
}
