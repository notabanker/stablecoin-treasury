import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ratesToEur } from "../../../packages/shared/data.mjs";
import { createJsonService, ok, route } from "../../../packages/shared/http.mjs";
import { serviceGet, servicePost, serviceUrls } from "../../../packages/shared/service-client.mjs";

const port = Number(process.env.GATEWAY_PORT || process.env.PORT || 8080);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = resolve(projectRoot, "apps/web");

createJsonService({
  name: "api-gateway",
  port,
  staticRoot: webRoot,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "api-gateway" })),
    route("GET", "/ready", async () => ok(await readiness())),
    route("GET", "/api/docs", () => ok(apiDocs())),
    route("GET", "/api/state", async () => ok(await composeState())),
    route("POST", "/api/reset", async () => {
      await Promise.all([
        servicePost("wallet", "/reset"),
        servicePost("policy", "/reset"),
        servicePost("compliance", "/reset"),
        servicePost("payment", "/reset"),
        servicePost("accounting", "/reset"),
        servicePost("reconciliation", "/reset"),
        servicePost("operations", "/reset")
      ]);
      return ok({ state: await composeState() });
    }),
    route("POST", "/api/payments", async ({ body, headers }) => {
      // Idempotency identity must never be derived from a client-controlled value (the
      // x-request-id header is attacker/client-chosen). If the caller sends no key, a fresh
      // server-generated UUID is used so retries are simply not deduplicated -- callers who
      // want retry-safety must supply their own Idempotency-Key.
      const result = await servicePost("payment", "/payments", body, {
        idempotencyKey: headers["idempotency-key"] || randomUUID()
      });
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/payments/:id/approve", async ({ params }) => {
      const result = await servicePost("payment", `/payments/${params.id}/approve`);
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/payments/:id/execute", async ({ params }) => {
      const result = await servicePost("payment", `/payments/${params.id}/execute`);
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/payments/:id/cancel", async ({ params }) => {
      const result = await servicePost("payment", `/payments/${params.id}/cancel`);
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/policies", async ({ body }) => {
      await servicePost("policy", "/policies", body);
      await servicePost("operations", "/audit", {
        actor: "Marta Klein",
        action: "Policy updated",
        object: "Payment controls",
        detail: "Thresholds changed through gateway"
      });
      return ok({ state: await composeState() });
    }),
    route("POST", "/api/policies/assets/:assetId", async ({ params, body }) => {
      await servicePost("policy", `/policies/assets/${params.assetId}`, body);
      await servicePost("operations", "/audit", {
        actor: "Marta Klein",
        action: "Asset policy changed",
        object: params.assetId,
        detail: body.enabled ? "Asset allowed" : "Asset removed from allowlist"
      });
      return ok({ state: await composeState() });
    }),
    route("POST", "/api/reconciliation/:id/resolve", async ({ params }) => {
      const result = await servicePost("reconciliation", `/reconciliation/${params.id}/resolve`);
      await servicePost("operations", "/audit", {
        actor: "Marta Klein",
        action: "Reconciliation resolved",
        object: params.id,
        detail: result.issue
      });
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/reconciliation/exceptions/simulate", async () => {
      const payments = await serviceGet("payment", "/payments");
      const payment = payments.find((item) => item.status === "Settled") || payments[0];
      const result = await servicePost("reconciliation", "/reconciliation/exceptions/simulate", { payment });
      await servicePost("operations", "/audit", {
        actor: "Reconciliation engine",
        action: "Exception opened",
        object: payment.reference,
        detail: result.issue
      });
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/operations/providers/:id/toggle", async ({ params }) => {
      const provider = await servicePost("operations", `/providers/${params.id}/toggle`);
      return ok({ provider, state: await composeState() });
    }),
    route("POST", "/api/operations/incidents/simulate", async () => {
      const result = await servicePost("operations", "/incidents/simulate");
      return ok({ ...result, state: await composeState() });
    }),
    route("POST", "/api/accounting/export", async () => {
      await servicePost("accounting", "/journals/export");
      await servicePost("operations", "/audit", {
        actor: "Marta Klein",
        action: "Journal export created",
        object: "Accounting",
        detail: "Journal lines marked exported"
      });
      return ok({ state: await composeState() });
    })
  ]
});

async function composeState() {
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
    alerts
  ] = await Promise.all([
    serviceGet("wallet", "/entities"),
    serviceGet("wallet", "/assets"),
    serviceGet("wallet", "/wallets"),
    serviceGet("compliance", "/counterparties"),
    serviceGet("policy", "/policies"),
    serviceGet("payment", "/payments"),
    serviceGet("accounting", "/journals"),
    serviceGet("reconciliation", "/reconciliation"),
    serviceGet("operations", "/providers"),
    serviceGet("operations", "/audit"),
    serviceGet("operations", "/alerts")
  ]);

  return {
    activeView: "dashboard",
    alerts,
    assets,
    audit,
    counterparties,
    currentUser: {
      id: "usr-1",
      name: "Marta Klein",
      role: "Group Treasury Admin"
    },
    entities,
    journalEntries,
    lastUpdated: new Date().toISOString(),
    payments,
    policies,
    providers,
    ratesToEur,
    reconciliation,
    selectedPaymentId: payments[0]?.id || "",
    wallets
  };
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
      "GET /api/state",
      "POST /api/reset",
      "POST /api/payments",
      "POST /api/payments/:id/approve",
      "POST /api/payments/:id/execute",
      "POST /api/payments/:id/cancel",
      "POST /api/policies",
      "POST /api/policies/assets/:assetId",
      "POST /api/reconciliation/:id/resolve",
      "POST /api/reconciliation/exceptions/simulate",
      "POST /api/operations/providers/:id/toggle",
      "POST /api/operations/incidents/simulate",
      "POST /api/accounting/export"
    ]
  };
}
