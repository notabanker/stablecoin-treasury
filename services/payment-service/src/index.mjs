import { createId, estimateFee } from "../../../packages/shared/data.mjs";
import { query, withTransaction, runWithTenant } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { serviceGet, servicePost } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { appendOutboxEvents } from "../../../packages/shared/outbox.mjs";
import { enqueueJob, enqueueJobInTx } from "../../../packages/shared/jobs.mjs";
import { requiredApprovalsFor } from "./approvals.mjs";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "./idempotency.mjs";
import { reseedPayments } from "./seed.mjs";

const port = Number(process.env.PORT || 4104);
const DB = "payment";

validateProductionConfig("payment-service");
// Bootstrap runs outside any request: enter the default-tenant RLS context explicitly
// so the seeded-data existence check does not fail closed (0 rows) and reseed every boot.
await runWithTenant(DEFAULT_TENANT_ID, bootstrap);

// Money-path metrics for the payment domain: cached DB queries to avoid
// blocking the metrics scrape under load.
let paymentMetricsCache = { timestamp: 0, data: {} };
const PAYMENT_METRICS_CACHE_MS = 5000;

async function paymentExtraMetrics() {
  const now = Date.now();
  if (now - paymentMetricsCache.timestamp < PAYMENT_METRICS_CACHE_MS) return paymentMetricsCache.data;
  try {
    const [{ rows: stateRows }, { rows: failureRows }] = await Promise.all([
      query(DB,
        `SELECT status, COUNT(*)::int AS count,
           COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS max_age_ms
         FROM payment.payments GROUP BY status`
      ),
      query(DB,
        `SELECT step, COUNT(*)::int AS failures
         FROM payment.payment_execution_attempts WHERE outcome = 'error' GROUP BY step`
      )
    ]);
    const byState = {};
    for (const r of stateRows) byState[r.status] = { count: r.count, maxAgeMs: Math.round(r.max_age_ms) };
    const sagaFailures = {};
    for (const r of failureRows) sagaFailures[r.step] = r.failures;
    const stuckExecuting = (byState["Executing"]?.count || 0);
    paymentMetricsCache = {
      timestamp: now,
      data: { paymentsByState: byState, sagaStepFailures: sagaFailures, stuckExecuting }
    };
    return paymentMetricsCache.data;
  } catch {
    return paymentMetricsCache.data;
  }
}

createJsonService({
  name: "payment-service",
  port,
  internalAuthRequired: true,
  extraMetrics: paymentExtraMetrics,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "payment-service" }), { public: true }),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    route("POST", "/reset", async ({ headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      await reseedPayments(tenantId);
      return ok(await listPayments(tenantId));
    }),
    route("GET", "/payments", async ({ headers }) => ok(await listPayments(tenantIdFromHeaders(headers)))),
    route("GET", "/payments/:id", async ({ params, headers }) => ok(await findPayment(params.id, tenantIdFromHeaders(headers)))),
    route("GET", "/payments/:id/attempts", async ({ params, headers }) => ok(await listExecutionAttempts(params.id, tenantIdFromHeaders(headers)))),
    route("GET", "/payments/:id/approvals", async ({ params, headers }) => ok(await listApprovals(params.id, tenantIdFromHeaders(headers)))),
    route("POST", "/payments", async ({ body, headers, actingUser }) => ok({ payment: await createPayment(body, headers["idempotency-key"], tenantIdFromHeaders(headers), actingUser) })),
    route("POST", "/payments/:id/approve", async ({ params, headers, actingUser }) => ok({ payment: await approvePayment(params.id, tenantIdFromHeaders(headers), actingUser) })),
    route("POST", "/payments/:id/execute", async ({ params, headers }) => ok(await executePayment(params.id, tenantIdFromHeaders(headers)))),
    route("POST", "/payments/:id/cancel", async ({ params, headers, actingUser }) => ok({ payment: await cancelPayment(params.id, tenantIdFromHeaders(headers), actingUser) })),
    // Repair endpoints for stuck payments (M3.3)
    route("GET", "/repair", async ({ headers }) => ok(await listRepairable(tenantIdFromHeaders(headers)))),
    route("POST", "/repair/:id/retry", async ({ params, headers }) => ok(await retryExecution(params.id, tenantIdFromHeaders(headers))))
  ]
});

async function createPayment(input, idempotencyKey, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
  let requestHash = null;
  if (idempotencyKey) {
    requestHash = hashRequest(input);
    const reservation = await reserveIdempotencyKey("create", idempotencyKey, requestHash, tenantId);
    if (reservation.outcome === "hash_mismatch") {
      throw httpError(422, "Idempotency-Key was already used with a different request body", "idempotency_key_reuse");
    }
    if (reservation.outcome === "pending") {
      throw httpError(409, "Idempotency-Key is already being processed; retry with the same key", "idempotency_in_progress");
    }
    if (reservation.outcome === "done") {
      return findPayment(reservation.paymentId, tenantId);
    }
  }

  try {
    const wallet = await serviceGet("wallet", `/wallets/${input.sourceWalletId}`, { tenantId });
    const counterparty = await serviceGet("compliance", `/counterparties/${input.counterpartyId}`, { tenantId });
    const policy = await serviceGet("policy", "/policies", { tenantId });
    const amount = Number(input.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw httpError(422, "Payment amount must be positive", "invalid_amount");
    }

    const payment = buildPaymentShape(input, wallet, counterparty, policy, amount);
    const evaluation = await evaluatePayment(payment, tenantId);
    let autoApproved = false;
    if (evaluation.decision.status === "Blocked") {
      payment.status = "Blocked";
    } else if (evaluation.decision.status === "Clear" && payment.requiredApprovals === 0) {
      payment.status = "Approved";
      autoApproved = true;
    }

    const outboxEvents = withTenant(buildCreationOutboxEvents(payment, evaluation, counterparty, autoApproved), tenantId);

    await withTransaction(DB, async (client) => {
      await insertPaymentInTx(client, payment, tenantId, actingUser?.id || null);
      payment.createdBy = actingUser?.id || null;
      if (autoApproved) {
        await client.query(
          `INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (payment_id, approver_id) DO NOTHING`,
          [tenantId, payment.id, "policy:auto", "Auto-approved by policy"]
        );
        await client.query(
          "UPDATE payment.payments SET approvals = 1 WHERE id = $1 AND tenant_id = $2",
          [payment.id, tenantId]
        );
        payment.approvals = 1;
      }
      if (idempotencyKey) {
        await completeIdempotencyKey("create", idempotencyKey, payment.id, client, tenantId);
      }
      await appendOutboxEvents(client, outboxEvents);
    });

    return payment;
  } catch (error) {
    if (idempotencyKey) {
      await releaseIdempotencyKey("create", idempotencyKey, tenantId);
    }
    throw error;
  }
}

function buildPaymentShape(input, wallet, counterparty, policy, amount) {
  return {
    id: createId("pay"),
    reference: "", // Assigned in the transaction below to keep the seq call inside the tx
    type: input.type || "Supplier",
    sourceWalletId: wallet.id,
    counterpartyId: counterparty.id,
    asset: wallet.asset,
    amount,
    fee: estimateFee(amount, wallet.asset),
    status: "Pending approval",
    approvals: 0,
    requiredApprovals: requiredApprovalsFor(amount, wallet.asset, policy),
    screenResult: counterparty.status === "Approved" ? "Clear" : counterparty.status,
    createdAt: new Date().toISOString(),
    settledAt: "",
    providerRef: "",
    chainRef: "",
    memo: String(input.memo || "").trim()
  };
}

function buildCreationOutboxEvents(payment, evaluation, counterparty, autoApproved) {
  if (evaluation.decision.status === "Blocked") {
    return [
      {
        aggregateType: "payment",
        aggregateId: payment.id,
        eventType: "reconciliation.exception_opened",
        payload: { payment, issue: evaluation.decision.detail, source: "Policy engine" }
      },
      {
        aggregateType: "payment",
        aggregateId: payment.id,
        eventType: "operations.alert_created",
        payload: { severity: "High", title: `${payment.reference} blocked`, detail: evaluation.decision.detail }
      },
      {
        aggregateType: "payment",
        aggregateId: payment.id,
        eventType: "audit.event_recorded",
        payload: { actor: "Policy engine", action: "Payment blocked", object: payment.reference, detail: evaluation.decision.detail }
      }
    ];
  }
  if (autoApproved) {
    return [{
      aggregateType: "payment",
      aggregateId: payment.id,
      eventType: "audit.event_recorded",
      payload: {
        actor: "Policy engine",
        action: "Payment auto-approved",
        object: payment.reference,
        detail: `${payment.asset} ${payment.amount} to ${counterparty.name} auto-approved (below approval threshold)`
      }
    }];
  }
  return [{
    aggregateType: "payment",
    aggregateId: payment.id,
    eventType: "audit.event_recorded",
    payload: {
      actor: "System",
      action: "Payment created",
      object: payment.reference,
      detail: `${payment.asset} ${payment.amount} to ${counterparty.name}`
    }
  }];
}

async function approvePayment(id, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
  const approverId = actingUser?.id || "system";
  const approverDisplay = actingUser?.display || "System";

  const payment = await findPayment(id, tenantId);
  if (["Approved", "Executing", "Settled"].includes(payment.status)) {
    return payment;
  }
  if (payment.status !== "Pending approval") {
    throw httpError(409, `Payment ${payment.reference} is not pending approval`, "invalid_state");
  }

  const evaluation = await evaluatePayment(payment, tenantId);
  if (evaluation.decision.status === "Blocked") {
    return withTransaction(DB, async (client) => {
      const updated = await transitionInTx(client, id, "Pending approval", { status: "Blocked" }, tenantId);
      await appendOutboxEvents(client, withTenant([{
        aggregateType: "payment",
        aggregateId: id,
        eventType: "audit.event_recorded",
        payload: { actor: approverDisplay, action: "Payment blocked", object: payment.reference, detail: evaluation.decision.detail }
      }], tenantId));
      return updated || (await findPayment(id, tenantId));
    });
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before approval`, "review_required");
  }

  // Creator-cannot-approve check. Fetch the policy: if selfApprovalAllowed is not
  // explicitly true (default false) and created_by matches approverId, deny.
  // Skip when created_by is null (legacy payments) or in dev mode where there is
  // only one system identity (four-eyes semantics require auth mode).
  const AUTH_DISABLED = !process.env.AUTH_REQUIRED || process.env.AUTH_REQUIRED !== "true";
  if (payment.createdBy && !AUTH_DISABLED) {
    const policy = await serviceGet("policy", "/policies", { tenantId });
    const selfApprovalAllowed = policy?.selfApprovalAllowed === true;
    if (payment.createdBy === approverId && !selfApprovalAllowed) {
      throw httpError(403, "Creator cannot approve their own payment", "self_approval_forbidden");
    }
  }

  // Same approver twice check — done inside the transaction with DB unique as backstop
  const updated = await withTransaction(DB, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, tenantId]
    );
    const current = fromRow(rows[0]);
    if (current.status !== "Pending approval") {
      return current;
    }

    // Insert approval row — UNIQUE(payment_id, approver_id) catches duplicates
    try {
      await client.query(
        `INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, id, approverId, approverDisplay]
      );
    } catch (error) {
      if (error.code === "23505") {
        throw httpError(409, "Already approved this payment", "already_approved");
      }
      throw error;
    }

    // Recompute approvals as distinct approver count
    const { rows: countRows } = await client.query(
      "SELECT COUNT(DISTINCT approver_id)::int AS c FROM payment.payment_approvals WHERE payment_id = $1",
      [id]
    );
    const approvals = countRows[0]?.c || 0;
    const nextStatus = approvals >= current.requiredApprovals ? "Approved" : "Pending approval";
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET approvals = $1, status = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
      [approvals, nextStatus, id, tenantId]
    );
    const result = fromRow(updatedRows[0]);
    await appendOutboxEvents(client, withTenant([{
      aggregateType: "payment",
      aggregateId: id,
      eventType: "audit.event_recorded",
      payload: {
        actor: approverDisplay,
        action: "Payment approved",
        object: result.reference,
        detail: `${result.approvals}/${result.requiredApprovals} approvals by ${approverDisplay}`
      }
    }], tenantId));
    return result;
  });
  return updated;
}

async function executePayment(id, tenantId = DEFAULT_TENANT_ID) {
  const payment = await findPayment(id, tenantId);

  if (payment.status === "Settled") {
    return { accepted: false, payment, message: "Already settled" };
  }
  if (payment.status === "Executing") {
    return { accepted: true, payment, message: "Execution is already in progress" };
  }
  if (payment.status !== "Approved") {
    throw httpError(409, `Payment ${payment.reference} is not approved`, "invalid_state");
  }

  const context = await getPaymentContext(payment, tenantId);
  const evaluation = await servicePost("policy", "/evaluate", { payment, ...context }, { tenantId });

  if (evaluation.decision.status === "Blocked") {
    return withTransaction(DB, async (client) => {
      const updated = await transitionInTx(client, id, "Approved", { status: "Blocked" }, tenantId);
      await appendOutboxEvents(client, withTenant([{
        aggregateType: "payment",
        aggregateId: id,
        eventType: "audit.event_recorded",
        payload: { actor: "Policy engine", action: "Execution blocked", object: payment.reference, detail: evaluation.decision.detail }
      }], tenantId));
      return { accepted: false, payment: updated || (await findPayment(id, tenantId)), message: "Blocked by policy" };
    });
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before execution`, "review_required");
  }

  // Transition to Executing and enqueue the saga job in a single transaction so we never
  // have a payment stuck at Executing without a corresponding job.
  const updated = await withTransaction(DB, async (client) => {
    const transitioned = await transitionInTx(client, id, "Approved", { status: "Executing" }, tenantId);
    if (!transitioned) {
      throw httpError(409, `Payment ${payment.reference} state changed concurrently`, "concurrent_modification");
    }
    await enqueueJobInTx(client, "execute-payment", { paymentId: id, tenantId }, { maxAttempts: 5, tenantId });
    await appendOutboxEvents(client, withTenant([{
      aggregateType: "payment",
      aggregateId: id,
      eventType: "audit.event_recorded",
      payload: { actor: "System", action: "Execution enqueued", object: payment.reference, detail: "Saga job enqueued" }
    }], tenantId));
    return transitioned;
  });

  return { accepted: true, payment: updated, message: "Payment execution enqueued" };
}

async function cancelPayment(id, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
  const actorName = actingUser?.display || "System";
  const payment = await findPayment(id, tenantId);
  if (payment.status === "Cancelled") {
    return payment;
  }
  if (!["Pending approval", "Approved"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} cannot be cancelled`, "invalid_state");
  }
  const updated = await withTransaction(DB, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, tenantId]
    );
    const current = fromRow(rows[0]);
    if (!["Pending approval", "Approved"].includes(current.status)) {
      return current;
    }
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET status = 'Cancelled' WHERE id = $1 AND tenant_id = $2 RETURNING *",
      [id, tenantId]
    );
    const result = fromRow(updatedRows[0]);
    await appendOutboxEvents(client, withTenant([{
      aggregateType: "payment",
      aggregateId: id,
      eventType: "audit.event_recorded",
      payload: { actor: actorName, action: "Payment cancelled", object: result.reference, detail: "User cancelled payment before execution" }
    }], tenantId));
    return result;
  });
  return updated;
}

// — Repair helpers (M3.3) —

async function listRepairable(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    "SELECT * FROM payment.payments WHERE tenant_id = $1 AND (status = 'Executing' OR status = 'Failed') ORDER BY created_at DESC",
    [tenantId]
  );
  const results = [];
  for (const row of rows) {
    const payment = fromRow(row);
    const [attempts, jobs] = await Promise.all([
      fetchAttempts(payment.id, tenantId),
      fetchJobsForPayment(payment.id, tenantId)
    ]);
    results.push({ payment, attempts, jobs });
  }
  return results;
}

async function retryExecution(id, tenantId = DEFAULT_TENANT_ID) {
  const payment = await findPayment(id, tenantId);
  if (!["Executing", "Failed"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} is not in a retryable state`, "invalid_state");
  }

  // Always enqueue a new saga job. The saga handler is idempotent at every step, so
  // concurrent or duplicate jobs for the same payment are safe — each step (ledger debit,
  // journal creation, reconciliation) deduplicates by key or constraint.
  if (payment.status === "Failed") {
    await query(
      DB,
      "UPDATE payment.payments SET status = 'Executing' WHERE id = $1 AND tenant_id = $2 AND status = 'Failed'",
      [id, tenantId]
    );
  }

  const job = await enqueueJob("execute-payment", { paymentId: id, tenantId }, { maxAttempts: 5, tenantId });
  return {
    accepted: true,
    jobId: job.id,
    payment: await findPayment(id, tenantId),
    message: "Payment execution retry enqueued"
  };
}

// — Database helpers —

async function evaluatePayment(payment, tenantId = DEFAULT_TENANT_ID) {
  const context = await getPaymentContext(payment, tenantId);
  return servicePost("policy", "/evaluate", { payment, ...context }, { tenantId });
}

async function getPaymentContext(payment, tenantId = DEFAULT_TENANT_ID) {
  const wallet = await serviceGet("wallet", `/wallets/${payment.sourceWalletId}`, { tenantId });
  const entity = await serviceGet("wallet", `/entities/${wallet.entityId}`, { tenantId });
  const asset = await serviceGet("wallet", `/assets/${payment.asset}`, { tenantId });
  const counterparty = await serviceGet("compliance", `/counterparties/${payment.counterpartyId}`, { tenantId });
  const provider = await serviceGet("operations", `/providers/${wallet.providerId}`, { tenantId });
  const wallets = await serviceGet("wallet", "/wallets", { tenantId });
  return { wallet, wallets, entity, asset, counterparty, provider };
}

async function transitionInTx(client, id, fromStatus, patch, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query(
    "SELECT status FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [id, tenantId]
  );
  if (!rows[0] || rows[0].status !== fromStatus) {
    return null;
  }
  const sets = [];
  const values = [];
  let i = 1;
  for (const [column, value] of Object.entries(patch)) {
    sets.push(`${toColumn(column)} = $${i}`);
    values.push(value);
    i += 1;
  }
  values.push(id, tenantId);
  const { rows: updatedRows } = await client.query(
    `UPDATE payment.payments SET ${sets.join(", ")} WHERE id = $${i} AND tenant_id = $${i + 1} RETURNING *`,
    values
  );
  return fromRow(updatedRows[0]);
}

function toColumn(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

async function findOpenExecutionJobInTx(client, paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query(
    `SELECT *
       FROM platform.jobs
      WHERE tenant_id = $1
        AND type = 'execute-payment'
        AND payload->>'paymentId' = $2
        AND status IN ('pending', 'running', 'failed')
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, paymentId]
  );
  return rows[0] || null;
}

async function insertPaymentInTx(client, payment, tenantId = DEFAULT_TENANT_ID, createdBy = null) {
  payment.reference = await allocateReference(client);
  await client.query(
    `INSERT INTO payment.payments
       (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result, provider_ref, chain_ref, memo, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      payment.id,
      tenantId,
      payment.reference,
      payment.type,
      payment.sourceWalletId,
      payment.counterpartyId,
      payment.asset,
      payment.amount,
      payment.fee,
      payment.status,
      payment.approvals,
      payment.requiredApprovals,
      payment.screenResult,
      payment.providerRef,
      payment.chainRef,
      payment.memo,
      payment.createdAt,
      createdBy
    ]
  );
}

function fromRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    sourceWalletId: row.source_wallet_id,
    counterpartyId: row.counterparty_id,
    asset: row.asset,
    amount: Number(row.amount),
    fee: Number(row.fee),
    status: row.status,
    approvals: row.approvals,
    requiredApprovals: row.required_approvals,
    screenResult: row.screen_result,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    settledAt: row.settled_at ? (row.settled_at instanceof Date ? row.settled_at.toISOString() : row.settled_at) : "",
    providerRef: row.provider_ref,
    chainRef: row.chain_ref,
    memo: row.memo,
    createdBy: row.created_by || null
  };
}

async function listPayments(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
  return rows.map(fromRow);
}

async function findPayment(id, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rows[0]) {
    throw httpError(404, `payment ${id} not found`, "not_found");
  }
  return fromRow(rows[0]);
}

async function fetchAttempts(paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    "SELECT * FROM payment.payment_execution_attempts WHERE payment_id = $1 AND tenant_id = $2 ORDER BY at",
    [paymentId, tenantId]
  );
  return rows.map((r) => ({
    id: r.id,
    step: r.step,
    outcome: r.outcome,
    error: r.error,
    at: r.at instanceof Date ? r.at.toISOString() : r.at
  }));
}

async function fetchJobsForPayment(paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    `SELECT id, type, status, attempts, max_attempts, last_error, created_at, completed_at
     FROM platform.jobs
     WHERE tenant_id = $1
       AND payload->>'paymentId' = $2
     ORDER BY created_at DESC`,
    [tenantId, paymentId]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    completedAt: r.completed_at ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : r.completed_at) : null
  }));
}

async function listExecutionAttempts(paymentId, tenantId = DEFAULT_TENANT_ID) {
  return fetchAttempts(paymentId, tenantId);
}

async function listApprovals(paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB,
    "SELECT approver_id, approver_display, approved_at FROM payment.payment_approvals WHERE payment_id = $1 AND tenant_id = $2 ORDER BY approved_at",
    [paymentId, tenantId]
  );
  return rows.map((r) => ({
    approverId: r.approver_id,
    display: r.approver_display,
    approvedAt: r.approved_at
  }));
}

function withTenant(events, tenantId) {
  return events.map((event) => ({ ...event, tenantId }));
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM payment.payments WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedPayments();
  }
}
