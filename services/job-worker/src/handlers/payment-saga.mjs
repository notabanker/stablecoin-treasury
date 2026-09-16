import { resolveAdapter, withBreaker } from "../../../../packages/shared/adapters/custody.mjs";
import { query } from "../../../../packages/shared/db.mjs";
import { logError } from "../../../../packages/shared/log.mjs";
import { appendOutboxEvents } from "../../../../packages/shared/outbox.mjs";
import { fromPaymentRow, getPaymentContext, withTenant } from "../../../../packages/shared/payment.mjs";
import { servicePost } from "../../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../../packages/shared/tenant.mjs";

const PB = "payment";

export async function executePayment(job) {
  const tenantId = job.tenant_id || job.payload.tenantId || DEFAULT_TENANT_ID;
  await executePaymentSaga(job.payload.paymentId, job.id, tenantId);
}

// The settle saga: policy re-check, provider submission, ledger debit, journal, reconciliation,
// settlement. Every step is idempotent, so at-least-once job delivery is safe.
async function executePaymentSaga(paymentId, jobId, tenantId = DEFAULT_TENANT_ID) {
  // Re-fetch payment inside the saga: the worker is a different process from the service that
  // enqueued the job and needs the latest state.
  const { rows: paymentRows } = await query(PB, "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2", [paymentId, tenantId]);
  if (!paymentRows[0]) throw new Error(`Payment ${paymentId} not found`);
  const payment = fromPaymentRow(paymentRows[0]);

  if (payment.status === "Settled") return; // Idempotent retry: already done.
  if (payment.status !== "Executing") {
    throw new Error(`Payment ${payment.reference} is not in Executing state (${payment.status})`);
  }

  const context = await getPaymentContext(payment, tenantId);

  // Step 1: Policy final check
  await recordAttempt(paymentId, jobId, "policy_check", "started", null, tenantId);
  const evaluation = await servicePost("policy", "/evaluate", { payment, ...context }, { tenantId });
  if (evaluation.decision.status === "Blocked") {
    await recordAttempt(paymentId, jobId, "policy_check", "error", evaluation.decision.detail || "Policy blocked execution", tenantId);
    await failPayment(paymentId, tenantId);
    return;
  }
  if (evaluation.decision.status === "Review") {
    await recordAttempt(paymentId, jobId, "policy_check", "error", "Review required", tenantId);
    throw new Error(`Payment ${payment.reference} requires review before execution`);
  }
  await recordAttempt(paymentId, jobId, "policy_check", "success", null, tenantId);

  // Step 2: Provider submission (before debit — if the provider rejects, we never debit).
  // Crash-safe (V8 Task 0.3, Finding 1 -- CRITICAL): payment.provider_submissions is inserted
  // with a deterministic idempotency key (payment:<id>) BEFORE the external call. A crash
  // between the provider accepting the transfer and this process persisting the result used to
  // mean a retry called submitTransfer() again with no idempotency key -- a duplicate external
  // transfer on a real rail. Now every attempt (first or retry) reuses the same key, and the
  // provider's own idempotency guarantee (packages/shared/adapters/custody.mjs on the
  // simulated rail) returns the already-accepted result instead of creating a new one.
  await recordAttempt(paymentId, jobId, "provider_submission", "started", null, tenantId);
  let providerRef = payment.providerRef;
  let chainRef = payment.chainRef;
  if (!providerRef) {
    const providerId = context.providerId || context.provider?.id || "prov-arcadia";
    const idempotencyKey = `payment:${paymentId}`;
    const submission = await ensureProviderSubmission(tenantId, paymentId, providerId, idempotencyKey);
    if (submission.status === "submitted" && submission.provider_ref) {
      // Resuming a crashed attempt: the provider already has this transfer under our
      // idempotency key. Reuse the recorded result -- do not call the adapter again.
      providerRef = submission.provider_ref;
      chainRef = submission.chain_ref;
    } else {
      try {
        const adapter = await resolveAdapter(providerId);
        if (!adapter) {
          throw Object.assign(new Error("No custody adapter resolved"), { code: "adapter_unavailable" });
        }
        const result = await withBreaker(providerId, () => adapter.submitTransfer({ payment, context, idempotencyKey }));
        providerRef = result.providerRef;
        chainRef = result.chainRef;
        await query(PB,
          "UPDATE payment.provider_submissions SET status = 'submitted', provider_ref = $1, chain_ref = $2, updated_at = now() WHERE id = $3",
          [providerRef, chainRef, submission.id]
        );
      } catch (error) {
        await query(PB,
          "UPDATE payment.provider_submissions SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
          [error.message, submission.id]
        );
        await recordAttempt(paymentId, jobId, "provider_submission", "error", error.message, tenantId);
        await failPayment(paymentId, tenantId);
        return;
      }
    }
    await query(PB,
      "UPDATE payment.payments SET provider_ref = $1, chain_ref = $2 WHERE id = $3 AND tenant_id = $4",
      [providerRef, chainRef, paymentId, tenantId]
    );
  }
  await recordAttempt(paymentId, jobId, "provider_submission", "success", null, tenantId);

  // Step 3: Ledger debit (idempotent by idempotency_key, after provider ref is persisted).
  // By this point the provider has already accepted the transfer, so a debit failure here must
  // NOT mark the payment Failed -- that would silently lose the fact that external money already
  // moved (Finding 1's second failure mode). Leaving the payment in Executing surfaces it on
  // the existing GET /api/repair list instead.
  await recordAttempt(paymentId, jobId, "ledger_debit", "started", null, tenantId);
  const destinationWallet = context.wallets.find(
    (candidate) =>
      candidate.id !== payment.sourceWalletId &&
      candidate.address === context.counterparty.wallet &&
      candidate.asset === payment.asset
  );
  try {
    await servicePost("wallet", `/wallets/${payment.sourceWalletId}/debit`, {
      principal: payment.amount,
      fee: payment.fee,
      destinationWalletId: destinationWallet?.id,
      paymentId: payment.id
    }, { idempotencyKey: `debit:${payment.id}`, tenantId });
    await recordAttempt(paymentId, jobId, "ledger_debit", "success", null, tenantId);
  } catch (error) {
    await recordAttempt(paymentId, jobId, "ledger_debit", "error", error.message, tenantId);
    throw error;
  }

  // Step 4: Journal + reconciliation
  const settlingPayment = { ...payment, providerRef, chainRef, status: "Executing" };
  await step("journal_creation", () => servicePost("accounting", "/journals/from-payment", { payment: settlingPayment, ...context }, { tenantId }));

  await step("reconciliation", () => servicePost("reconciliation", "/reconciliation/matched", { payment: settlingPayment }, { tenantId }));

  // Step 5: Settle
  await recordAttempt(paymentId, jobId, "settlement", "started", null, tenantId);
  const settledAt = payment.settledAt || new Date().toISOString();
  await query(PB, "UPDATE payment.payments SET status = 'Settled', settled_at = $1 WHERE id = $2 AND tenant_id = $3", [
    settledAt, paymentId, tenantId
  ]);
  await recordAttempt(paymentId, jobId, "settlement", "success", null, tenantId);

  await appendOutboxEvents({ query: (text, params) => query(PB, text, params) }, withTenant([{
    aggregateType: "payment",
    aggregateId: paymentId,
    eventType: "audit.event_recorded",
    payload: {
      actor: "Arcadia Custody Bank",
      action: "Payment settled",
      object: payment.reference,
      detail: `Provider reference ${providerRef}`
    }
  }], tenantId));

  // V6 Epic 5.2, OPT-IN: the simulated rail emits a single-line provider statement on
  // settlement so the full settle -> ingest -> match path runs end to end without a partner.
  // Default OFF: enabling it would add a statement-confirmed match per settlement and change
  // demo/test reconciliation counts.
  if (process.env.SIMULATED_STATEMENT_EMIT === "true") {
    const providerId = context.providerId || context.provider?.id || "prov-arcadia";
    try {
      await servicePost("reconciliation", "/statements", {
        providerId,
        externalId: `sim-stmt-${providerRef}`,
        lines: [{ providerRef, amount: payment.amount, asset: payment.asset, occurredAt: settledAt }]
      }, { tenantId });
    } catch (error) {
      // Statement emission is a simulation aid, never a saga step: settlement stays settled.
      logError("simulated_statement_emit_failed", error);
    }
  }

  // Journal and reconciliation share the started/success/error attempt trail; an error here
  // throws so the job retries the remaining steps.
  async function step(name, run) {
    await recordAttempt(paymentId, jobId, name, "started", null, tenantId);
    try {
      await run();
      await recordAttempt(paymentId, jobId, name, "success", null, tenantId);
    } catch (error) {
      await recordAttempt(paymentId, jobId, name, "error", error.message, tenantId);
      throw error;
    }
  }
}

// Failing the payment is guarded by the current status so a concurrent settle is never undone.
async function failPayment(paymentId, tenantId) {
  await query(PB, "UPDATE payment.payments SET status = 'Failed' WHERE id = $1 AND tenant_id = $2 AND status = 'Executing'", [
    paymentId, tenantId
  ]);
}

async function recordAttempt(paymentId, jobId, step, outcome, error = null, tenantId = DEFAULT_TENANT_ID) {
  await query(PB,
    `INSERT INTO payment.payment_execution_attempts (tenant_id, payment_id, job_id, step, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, paymentId, jobId, step, outcome, error]
  );
}

// V8 Task 0.3.1/0.3.3 (Finding 1): insert-or-get the durable pre-commit submission row for this
// payment, before any external call. UNIQUE(tenant_id, payment_id) makes this safe to call on
// every attempt (first or retry) -- ON CONFLICT DO NOTHING plus a re-select returns the existing
// row, so a crashed prior attempt's idempotency_key and status are always what the caller sees.
async function ensureProviderSubmission(tenantId, paymentId, providerId, idempotencyKey) {
  await query(PB,
    `INSERT INTO payment.provider_submissions (tenant_id, payment_id, provider_id, idempotency_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, payment_id) DO NOTHING`,
    [tenantId, paymentId, providerId, idempotencyKey]
  );
  const { rows } = await query(PB,
    "SELECT * FROM payment.provider_submissions WHERE tenant_id = $1 AND payment_id = $2",
    [tenantId, paymentId]
  );
  return rows[0];
}
