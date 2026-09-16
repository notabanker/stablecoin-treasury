import { createId, estimateFee } from "../../../packages/shared/data.mjs";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { httpError } from "../../../packages/shared/http.mjs";
import { parseMoneyInput } from "../../../packages/shared/money.mjs";
import { getPaymentContext, fromPaymentRow, withTenant } from "../../../packages/shared/payment.mjs";
import { appendOutboxEvents } from "../../../packages/shared/outbox.mjs";
import { enqueueJob, enqueueJobInTx } from "../../../packages/shared/jobs.mjs";
import { iso } from "../../../packages/shared/rows.mjs";
import { serviceGet, servicePost } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { requiredApprovalsFor } from "./approvals.mjs";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "./idempotency.mjs";

const DB = "payment";

// ── Queries ─────────────────────────────────────────────────────────────

export async function listPayments(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
  return rows.map(fromPaymentRow);
}

export async function findPayment(id, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rows[0]) {
    throw httpError(404, `payment ${id} not found`, "not_found");
  }
  return fromPaymentRow(rows[0]);
}

export async function listExecutionAttempts(paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    "SELECT * FROM payment.payment_execution_attempts WHERE payment_id = $1 AND tenant_id = $2 ORDER BY at",
    [paymentId, tenantId]
  );
  return rows.map((row) => ({ id: row.id, step: row.step, outcome: row.outcome, error: row.error, at: iso(row.at) }));
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
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null
  }));
}

export async function listApprovals(paymentId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB,
    "SELECT approver_id, approver_display, approved_at FROM payment.payment_approvals WHERE payment_id = $1 AND tenant_id = $2 ORDER BY approved_at",
    [paymentId, tenantId]
  );
  return rows.map((row) => ({ approverId: row.approver_id, display: row.approver_display, approvedAt: row.approved_at }));
}

export async function listRepairable(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    "SELECT * FROM payment.payments WHERE tenant_id = $1 AND (status = 'Executing' OR status = 'Failed') ORDER BY created_at DESC",
    [tenantId]
  );
  const results = [];
  for (const row of rows) {
    const payment = fromPaymentRow(row);
    const [attempts, jobs] = await Promise.all([
      listExecutionAttempts(payment.id, tenantId),
      fetchJobsForPayment(payment.id, tenantId)
    ]);
    results.push({ payment, attempts, jobs });
  }
  return results;
}

// ── Commands ────────────────────────────────────────────────────────────

export async function createPayment(input, idempotencyKey, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
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
    let amount;
    try {
      amount = parseMoneyInput(input.amount ?? 0).toNumber();
    } catch {
      throw httpError(422, "Payment amount must be positive", "invalid_amount");
    }
    if (!(amount > 0)) {
      throw httpError(422, "Payment amount must be positive", "invalid_amount");
    }

    const payment = buildPaymentShape(input, wallet, counterparty, policy, amount);
    const evaluation = await evaluatePayment(payment, tenantId);
    const autoApproved = evaluation.decision.status === "Clear" && payment.requiredApprovals === 0;
    if (evaluation.decision.status === "Blocked") payment.status = "Blocked";
    else if (autoApproved) payment.status = "Approved";

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
    reference: "", // Assigned inside the insert transaction so the seq call stays transactional
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
  const event = (eventType, payload) => ({ aggregateType: "payment", aggregateId: payment.id, eventType, payload });
  if (evaluation.decision.status === "Blocked") {
    return [
      event("reconciliation.exception_opened", { payment, issue: evaluation.decision.detail, source: "Policy engine" }),
      event("operations.alert_created", { severity: "High", title: `${payment.reference} blocked`, detail: evaluation.decision.detail }),
      event("audit.event_recorded", { actor: "Policy engine", action: "Payment blocked", object: payment.reference, detail: evaluation.decision.detail })
    ];
  }
  if (autoApproved) {
    return [event("audit.event_recorded", {
      actor: "Policy engine",
      action: "Payment auto-approved",
      object: payment.reference,
      detail: `${payment.asset} ${payment.amount} to ${counterparty.name} auto-approved (below approval threshold)`
    })];
  }
  return [event("audit.event_recorded", {
    actor: "System",
    action: "Payment created",
    object: payment.reference,
    detail: `${payment.asset} ${payment.amount} to ${counterparty.name}`
  })];
}

export async function approvePayment(id, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
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
      await appendOutboxEvents(client, withTenant([auditEvent(id, "Payment blocked", approverDisplay, payment.reference, evaluation.decision.detail)], tenantId));
      return updated || (await findPayment(id, tenantId));
    });
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before approval`, "review_required");
  }

  // Creator-cannot-approve check. Fetch the policy: if selfApprovalAllowed is not explicitly
  // true (default false) and created_by matches approverId, deny. Skipped when created_by is
  // null (legacy payments) or when auth is off (dev has one system identity).
  if (payment.createdBy && process.env.AUTH_REQUIRED === "true") {
    const policy = await serviceGet("policy", "/policies", { tenantId });
    if (payment.createdBy === approverId && policy?.selfApprovalAllowed !== true) {
      throw httpError(403, "Creator cannot approve their own payment", "self_approval_forbidden");
    }
  }

  // Same approver twice is caught inside the transaction: UNIQUE(payment_id, approver_id)
  // is the DB backstop, the FOR UPDATE re-read is the isolation guard.
  return withTransaction(DB, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, tenantId]
    );
    const current = fromPaymentRow(rows[0]);
    if (current.status !== "Pending approval") {
      return current;
    }

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
    const status = approvals >= current.requiredApprovals ? "Approved" : "Pending approval";
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET approvals = $1, status = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
      [approvals, status, id, tenantId]
    );
    const result = fromPaymentRow(updatedRows[0]);
    await appendOutboxEvents(client, withTenant([
      auditEvent(id, "Payment approved", approverDisplay, result.reference, `${result.approvals}/${result.requiredApprovals} approvals by ${approverDisplay}`)
    ], tenantId));
    return result;
  });
}

export async function executePayment(id, tenantId = DEFAULT_TENANT_ID) {
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

  const evaluation = await evaluatePayment(payment, tenantId);
  if (evaluation.decision.status === "Blocked") {
    return withTransaction(DB, async (client) => {
      const updated = await transitionInTx(client, id, "Approved", { status: "Blocked" }, tenantId);
      await appendOutboxEvents(client, withTenant([
        auditEvent(id, "Execution blocked", "Policy engine", payment.reference, evaluation.decision.detail)
      ], tenantId));
      return { accepted: false, payment: updated || (await findPayment(id, tenantId)), message: "Blocked by policy" };
    });
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before execution`, "review_required");
  }

  // Transition to Executing and enqueue the saga job in one transaction so a payment is never
  // stuck at Executing without a corresponding job.
  const updated = await withTransaction(DB, async (client) => {
    const transitioned = await transitionInTx(client, id, "Approved", { status: "Executing" }, tenantId);
    if (!transitioned) {
      throw httpError(409, `Payment ${payment.reference} state changed concurrently`, "concurrent_modification");
    }
    await enqueueJobInTx(client, "execute-payment", { paymentId: id, tenantId }, { maxAttempts: 5, tenantId });
    await appendOutboxEvents(client, withTenant([
      auditEvent(id, "Execution enqueued", "System", payment.reference, "Saga job enqueued")
    ], tenantId));
    return transitioned;
  });

  return { accepted: true, payment: updated, message: "Payment execution enqueued" };
}

export async function cancelPayment(id, tenantId = DEFAULT_TENANT_ID, actingUser = null) {
  const payment = await findPayment(id, tenantId);
  if (payment.status === "Cancelled") {
    return payment;
  }
  if (!["Pending approval", "Approved"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} cannot be cancelled`, "invalid_state");
  }
  return withTransaction(DB, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, tenantId]
    );
    const current = fromPaymentRow(rows[0]);
    if (!["Pending approval", "Approved"].includes(current.status)) {
      return current;
    }
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET status = 'Cancelled' WHERE id = $1 AND tenant_id = $2 RETURNING *",
      [id, tenantId]
    );
    const result = fromPaymentRow(updatedRows[0]);
    await appendOutboxEvents(client, withTenant([
      auditEvent(id, "Payment cancelled", actingUser?.display || "System", result.reference, "User cancelled payment before execution")
    ], tenantId));
    return result;
  });
}

export async function retryExecution(id, tenantId = DEFAULT_TENANT_ID) {
  const payment = await findPayment(id, tenantId);
  if (!["Executing", "Failed"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} is not in a retryable state`, "invalid_state");
  }
  // Always enqueue a new saga job. The saga handler is idempotent at every step, so concurrent
  // or duplicate jobs for the same payment are safe.
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

// ── Internals ───────────────────────────────────────────────────────────

async function evaluatePayment(payment, tenantId = DEFAULT_TENANT_ID) {
  const context = await getPaymentContext(payment, tenantId);
  return servicePost("policy", "/evaluate", { payment, ...context }, { tenantId });
}

function auditEvent(paymentId, action, actor, object, detail) {
  return { aggregateType: "payment", aggregateId: paymentId, eventType: "audit.event_recorded", payload: { actor, action, object, detail } };
}

async function transitionInTx(client, id, fromStatus, patch, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query(
    "SELECT status FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [id, tenantId]
  );
  if (!rows[0] || rows[0].status !== fromStatus) {
    return null;
  }
  const columns = Object.keys(patch);
  const sets = columns.map((column, index) => `${toColumn(column)} = $${index + 1}`);
  const { rows: updatedRows } = await client.query(
    `UPDATE payment.payments SET ${sets.join(", ")} WHERE id = $${columns.length + 1} AND tenant_id = $${columns.length + 2} RETURNING *`,
    [...columns.map((column) => patch[column]), id, tenantId]
  );
  if (!updatedRows[0]) return null;
  return fromPaymentRow(updatedRows[0]);
}

function toColumn(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
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

// Exported for the service's metrics endpoint.
export async function metricsSnapshot() {
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
  for (const row of stateRows) byState[row.status] = { count: row.count, maxAgeMs: Math.round(row.max_age_ms) };
  const sagaStepFailures = {};
  for (const row of failureRows) sagaStepFailures[row.step] = row.failures;
  return { paymentsByState: byState, sagaStepFailures, stuckExecuting: byState.Executing?.count || 0 };
}
