import { ok, route } from "../../../packages/shared/http.mjs";
import { logError } from "../../../packages/shared/log.mjs";
import { createMetricsSnapshot } from "../../../packages/shared/metrics.mjs";
import { createDomainService } from "../../../packages/shared/service.mjs";
import {
  approvePayment, cancelPayment, createPayment, executePayment, findPayment,
  listApprovals, listExecutionAttempts, listPayments, listRepairable, metricsSnapshot, retryExecution
} from "./payments.mjs";
import { reseedPayments } from "./seed.mjs";

const port = Number(process.env.PORT || 4104);

// Money-path metrics for the payment domain, cached so /metrics never blocks on the DB.
const extraMetrics = createMetricsSnapshot(metricsSnapshot, {
  onError: (error) => logError("payment_metrics_failed", error)
});

await createDomainService({
  name: "payment-service",
  port,
  db: "payment",
  metrics: extraMetrics,
  seed: { table: "payment.payments", reseed: reseedPayments, list: listPayments },
  routes: [
    route("GET", "/payments", async ({ tenantId }) => ok(await listPayments(tenantId))),
    route("GET", "/payments/:id", async ({ params, tenantId }) => ok(await findPayment(params.id, tenantId))),
    route("GET", "/payments/:id/attempts", async ({ params, tenantId }) => ok(await listExecutionAttempts(params.id, tenantId))),
    route("GET", "/payments/:id/approvals", async ({ params, tenantId }) => ok(await listApprovals(params.id, tenantId))),
    route("POST", "/payments", async ({ body, headers, actingUser, tenantId }) =>
      ok({ payment: await createPayment(body, headers["idempotency-key"], tenantId, actingUser) })),
    route("POST", "/payments/:id/approve", async ({ params, actingUser, tenantId }) =>
      ok({ payment: await approvePayment(params.id, tenantId, actingUser) })),
    route("POST", "/payments/:id/execute", async ({ params, tenantId }) => ok(await executePayment(params.id, tenantId))),
    route("POST", "/payments/:id/cancel", async ({ params, actingUser, tenantId }) =>
      ok({ payment: await cancelPayment(params.id, tenantId, actingUser) })),
    // Repair endpoints for stuck payments (M3.3)
    route("GET", "/repair", async ({ tenantId }) => ok(await listRepairable(tenantId))),
    route("POST", "/repair/:id/retry", async ({ params, tenantId }) => ok(await retryExecution(params.id, tenantId)))
  ]
});
