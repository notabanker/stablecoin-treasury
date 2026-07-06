import { createServer } from "node:http";
import { verifyAuditChain } from "../../../packages/shared/audit.mjs";
import { query } from "../../../packages/shared/db.mjs";
import { claimJobs, completeJob, failJob } from "../../../packages/shared/jobs.mjs";
import { serviceGet, servicePost } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { resolveAdapter, withBreaker } from "../../../packages/shared/adapters/custody.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";

const WORKER_ID = `worker-${Math.random().toString(36).slice(2, 10)}`;
const POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 500);
const BATCH_LIMIT = 5;
let running = true;
const startedAt = new Date().toISOString();
const metrics = { claimed: 0, completed: 0, failed: 0, deadLettered: 0, noHandler: 0 };

// Money-path metrics cache: DB queries are run at most once per METRICS_CACHE_MS.
const METRICS_CACHE_MS = 5000;
let metricsCache = { timestamp: 0, queueDepth: 0, deadLetterCount: 0, oldestPendingJobAgeMs: 0 };

async function refreshMetricsCache() {
  const now = Date.now();
  if (now - metricsCache.timestamp < METRICS_CACHE_MS) return;
  try {
    const { rows } = await query("platform",
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS queue_depth,
         COUNT(*) FILTER (WHERE status = 'dead_lettered')::int AS dead_letter_count,
         COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE status = 'pending')) * 1000, 0)::float AS oldest_pending_job_age_ms
       FROM platform.jobs WHERE status IN ('pending', 'dead_lettered')`
    );
    metricsCache = {
      timestamp: now,
      queueDepth: rows[0]?.queue_depth ?? 0,
      deadLetterCount: rows[0]?.dead_letter_count ?? 0,
      oldestPendingJobAgeMs: Math.round(rows[0]?.oldest_pending_job_age_ms ?? 0)
    };
  } catch {
    // stale cache is better than a broken metrics endpoint
  }
}

validateProductionConfig("job-worker");

const healthPort = Number(process.env.PORT || 9102);
const healthServer = createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  if (req.url === "/metrics") {
    await refreshMetricsCache();
    res.end(JSON.stringify({
      status: "ok",
      service: "job-worker",
      startedAt,
      claimed: metrics.claimed,
      completed: metrics.completed,
      failed: metrics.failed,
      deadLettered: metrics.deadLettered,
      noHandler: metrics.noHandler,
      queueDepth: metricsCache.queueDepth,
      deadLetterCount: metricsCache.deadLetterCount,
      oldestPendingJobAgeMs: metricsCache.oldestPendingJobAgeMs
    }));
  } else {
    res.end(JSON.stringify({ status: "ok", service: "job-worker" }));
  }
});
healthServer.listen(healthPort, "127.0.0.1");
healthServer.unref();

// Handler registry: maps job type string to the async function that executes it.
const handlers = {};

export function registerHandler(type, fn) {
  handlers[type] = fn;
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// — execute-payment saga handler —
registerHandler("execute-payment", async (job) => {
  const { paymentId } = job.payload;
  await executePaymentSaga(paymentId, job.id, job.tenant_id || job.payload.tenantId || DEFAULT_TENANT_ID);
});

// — payment-autoe-expiry handler —
registerHandler("payment-auto-expiry", async () => {
  const { rows } = await query(
    "payment",
    `UPDATE payment.payments
     SET status = 'Cancelled'
     WHERE status = 'Pending approval'
       AND tenant_id = $1
       AND created_at < now() - INTERVAL '72 hours'
     RETURNING id, reference`,
    [DEFAULT_TENANT_ID]
  );
  if (rows.length > 0) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: "auto_expiry",
      expired: rows.length,
      paymentIds: rows.map((r) => r.id)
    }));
  }
});

// — idempotency-sweeper handler —
registerHandler("idempotency-sweep", async () => {
  const { rows } = await query(
    "payment",
    `DELETE FROM payment.idempotency_keys
     WHERE status = 'done'
       AND created_at < now() - INTERVAL '48 hours'`
  );
  if (rows.length > 0) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: "idempotency_sweep",
      deleted: rows.length
    }));
  }
});

// — process-settlement-webhook handler (V3.7) —
registerHandler("process-settlement-webhook", async (job) => {
  const { providerId, eventId, paymentRef } = job.payload;
  const tenantId = job.tenant_id || job.payload.tenantId || DEFAULT_TENANT_ID;
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    event: "webhook_processing",
    providerId,
    eventId,
    paymentRef
  }));
  // Update webhook status
  await query(
    "platform",
    "UPDATE platform.webhook_events SET status = 'processed', processed_at = now() WHERE provider_id = $1 AND external_id = $2 AND tenant_id = $3",
    [providerId, eventId, tenantId]
  );
  // Future: trigger reconciliation match or saga settlement confirmation
});

// — match-statement handler (V6 Epic 5.2) —
// The job worker orchestrates over HTTP like the saga does: the reconciliation role owns
// its schema; the worker never touches reconciliation tables directly.
registerHandler("match-statement", async (job) => {
  const tenantId = job.tenant_id || DEFAULT_TENANT_ID;
  const { statementId } = job.payload;
  await servicePost("reconciliation", `/statements/${statementId}/match`, {}, { tenantId });
});

// — ops-watchdog handler —
const WATCHDOG_STUCK_EXECUTING_MS = Number(process.env.WATCHDOG_STUCK_EXECUTING_MS || 300000); // 5 minutes
const WATCHDOG_OUTBOX_LAG_MS = Number(process.env.WATCHDOG_OUTBOX_LAG_MS || 60000); // 1 minute
const WATCHDOG_PENDING_JOB_AGE_MS = Number(process.env.WATCHDOG_PENDING_JOB_AGE_MS || 300000); // 5 minutes

registerHandler("ops-watchdog", async () => {
  await runWatchdog(DEFAULT_TENANT_ID);
});

async function runWatchdog(tenantId) {
  const checks = [];

  // Stuck Executing payments
  const { rows: stuckRows } = await query("payment",
    `SELECT COUNT(*)::int AS count
     FROM payment.payments
     WHERE status = 'Executing'
       AND tenant_id = $1
       AND created_at < now() - ($2 || ' ms')::interval`,
    [tenantId, String(WATCHDOG_STUCK_EXECUTING_MS)]
  );
  checks.push({
    type: "stuck_executing_payments",
    title: "Stuck Executing payments",
    count: stuckRows[0]?.count || 0,
    threshold: 0
  });

  // Outbox lag
  const { rows: outboxRows } = await query("platform",
    `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS lag_ms
     FROM platform.outbox_events WHERE published_at IS NULL`
  );
  const outboxLag = Math.round(outboxRows[0]?.lag_ms || 0);
  checks.push({
    type: "outbox_lag",
    title: "Outbox lag exceeded",
    count: outboxLag,
    threshold: WATCHDOG_OUTBOX_LAG_MS
  });

  // Dead-letter queue
  const { rows: dlqRows } = await query("platform",
    "SELECT COUNT(*)::int AS count FROM platform.jobs WHERE status = 'dead_lettered'"
  );
  const dlqCount = dlqRows[0]?.count || 0;
  checks.push({
    type: "dead_letter_queue",
    title: "Dead-letter queue non-empty",
    count: dlqCount,
    threshold: 0
  });

  // Oldest pending job
  const { rows: pendingRows } = await query("platform",
    `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS age_ms
     FROM platform.jobs WHERE status = 'pending'`
  );
  const pendingAge = Math.round(pendingRows[0]?.age_ms || 0);
  checks.push({
    type: "pending_job_age",
    title: "Pending job age exceeded",
    count: pendingAge,
    threshold: WATCHDOG_PENDING_JOB_AGE_MS
  });

  for (const check of checks) {
    await evaluateWatchdogCheck(tenantId, check);
  }
}

// — audit-chain-verify handler (V6 Epic 3) —
// Recomputes every audit row hash and checks per-tenant linkage/continuity. On break:
// one Open alert per broken tenant (deduped like watchdog alerts). When the chain is
// fully intact, open chain alerts are closed (e.g. after a demo reset rebuilt the chain).
const AUDIT_CHAIN_ALERT_TITLE = "Audit chain integrity violation";

registerHandler("audit-chain-verify", async () => {
  const result = await verifyAuditChain("operations");
  if (result.ok) {
    await query("operations",
      "UPDATE operations.alerts SET status = 'Closed' WHERE title = $1 AND status = 'Open'",
      [AUDIT_CHAIN_ALERT_TITLE]
    );
    return;
  }
  const broken = result.break;
  console.error(JSON.stringify({ at: new Date().toISOString(), event: "audit_chain_break", ...broken }));
  const { rows: existing } = await query("operations",
    "SELECT id FROM operations.alerts WHERE tenant_id = $1 AND title = $2 AND status = 'Open' LIMIT 1",
    [broken.tenantId, AUDIT_CHAIN_ALERT_TITLE]
  );
  if (!existing[0]) {
    await query("operations",
      `INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status)
       VALUES ($1, $2, 'High', $3, $4, 'Open')`,
      [`ac-${Date.now().toString(36)}`, broken.tenantId, AUDIT_CHAIN_ALERT_TITLE,
       `${broken.reason} at chain_seq ${broken.chainSeq} (event ${broken.id}). See docs/RUNBOOKS.md "Audit chain break".`]
    );
  }
});

async function evaluateWatchdogCheck(tenantId, check) {
  const alertTitle = `${check.title}`;
  const triggered = check.count > check.threshold;

  // Check for existing open alert
  const { rows: existing } = await query("operations",
    "SELECT id, status FROM operations.alerts WHERE tenant_id = $1 AND title = $2 ORDER BY created_at DESC LIMIT 1",
    [tenantId, alertTitle]
  );

  if (triggered) {
    // Create alert only if no open alert exists for this type
    const openAlert = existing.find((a) => a.status === "Open");
    if (!openAlert) {
      const alertId = `wd-${check.type}-${Date.now().toString(36)}`;
      await query("operations",
        `INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status)
         VALUES ($1, $2, $3, $4, $5, 'Open')`,
        [alertId, tenantId, "High", alertTitle,
         `${check.type}: ${check.count} > ${check.threshold}. Outbox lag: ${check.count}ms.`]
      );
    }
  } else if (existing.length > 0) {
    // Condition cleared: close all open alerts of this type
    await query("operations",
      "UPDATE operations.alerts SET status = 'Closed' WHERE tenant_id = $1 AND title = $2 AND status = 'Open'",
      [tenantId, alertTitle]
    );
  }
}

async function executePaymentSaga(paymentId, jobId, tenantId = DEFAULT_TENANT_ID) {
  const PB = "payment";

  // Re-fetch payment inside the saga because the worker is a different process from the service
  // that enqueued the job, and we need the latest state.
  const { rows: paymentRows } = await query(
    PB,
    "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2",
    [paymentId, tenantId]
  );
  if (!paymentRows[0]) throw new Error(`Payment ${paymentId} not found`);
  const payment = fromPaymentRow(paymentRows[0]);

  if (payment.status === "Settled") {
    return; // Idempotent retry: already done.
  }
  if (payment.status !== "Executing") {
    throw new Error(`Payment ${payment.reference} is not in Executing state (${payment.status})`);
  }

  const context = await getPaymentContext(payment, tenantId);

  // Step 1: Policy final check
  await recordAttempt(paymentId, jobId, "policy_check", "started", null, tenantId);
  const evaluation = await servicePost("policy", "/evaluate", { payment, ...context }, { tenantId });
  if (evaluation.decision.status === "Blocked") {
    await recordAttempt(paymentId, jobId, "policy_check", "error", evaluation.decision.detail || "Policy blocked execution", tenantId);
    await query(PB, "UPDATE payment.payments SET status = 'Failed' WHERE id = $1 AND tenant_id = $2 AND status = 'Executing'", [
      paymentId, tenantId
    ]);
    return;
  }
  if (evaluation.decision.status === "Review") {
    await recordAttempt(paymentId, jobId, "policy_check", "error", "Review required", tenantId);
    throw new Error(`Payment ${payment.reference} requires review before execution`);
  }
  await recordAttempt(paymentId, jobId, "policy_check", "success", null, tenantId);

  // Step 2: Provider submission (before debit — if the provider rejects, we never debit).
  // Idempotent: if provider_ref already set from a previous crashed attempt, skip re-submission.
  await recordAttempt(paymentId, jobId, "provider_submission", "started", null, tenantId);
  let providerRef = payment.providerRef;
  let chainRef = payment.chainRef;
  if (!providerRef) {
    try {
      const adapter = await resolveAdapter(context.providerId || context.provider?.id || "prov-arcadia");
      if (!adapter) {
        throw Object.assign(new Error("No custody adapter resolved"), { code: "adapter_unavailable" });
      }
      const result = await withBreaker(
        context.providerId || context.provider?.id || "prov-arcadia",
        () => adapter.submitTransfer({ payment, context })
      );
      providerRef = result.providerRef;
      chainRef = result.chainRef;
      await query(
        PB,
        "UPDATE payment.payments SET provider_ref = $1, chain_ref = $2 WHERE id = $3 AND tenant_id = $4",
        [providerRef, chainRef, paymentId, tenantId]
      );
    } catch (error) {
      await recordAttempt(paymentId, jobId, "provider_submission", "error", error.message, tenantId);
      await query(PB, "UPDATE payment.payments SET status = 'Failed' WHERE id = $1 AND tenant_id = $2 AND status = 'Executing'", [
        paymentId, tenantId
      ]);
      return;
    }
  }
  await recordAttempt(paymentId, jobId, "provider_submission", "success", null, tenantId);

  // Step 3: Ledger debit (idempotent by idempotency_key, after provider ref is persisted).
  await recordAttempt(paymentId, jobId, "ledger_debit", "started", null, tenantId);
  const destinationWallet = context.wallets.find(
    (candidate) =>
      candidate.id !== payment.sourceWalletId &&
      candidate.address === context.counterparty.wallet &&
      candidate.asset === payment.asset
  );
  try {
    await servicePost(
      "wallet",
      `/wallets/${payment.sourceWalletId}/debit`,
      {
        principal: payment.amount,
        fee: payment.fee,
        destinationWalletId: destinationWallet?.id,
        paymentId: payment.id
      },
      { idempotencyKey: `debit:${payment.id}`, tenantId }
    );
    await recordAttempt(paymentId, jobId, "ledger_debit", "success", null, tenantId);
  } catch (error) {
    await recordAttempt(paymentId, jobId, "ledger_debit", "error", error.message, tenantId);
    await query(PB, "UPDATE payment.payments SET status = 'Failed' WHERE id = $1 AND tenant_id = $2 AND status = 'Executing'", [
      paymentId, tenantId
    ]);
    throw error;
  }

  // Step 4: Journal + reconciliation + settle
  const settlingPayment = { ...payment, providerRef, chainRef, status: "Executing" };
  await recordAttempt(paymentId, jobId, "journal_creation", "started", null, tenantId);
  try {
    await servicePost("accounting", "/journals/from-payment", { payment: settlingPayment, ...context }, { tenantId });
    await recordAttempt(paymentId, jobId, "journal_creation", "success", null, tenantId);
  } catch (error) {
    await recordAttempt(paymentId, jobId, "journal_creation", "error", error.message, tenantId);
    throw error;
  }

  await recordAttempt(paymentId, jobId, "reconciliation", "started", null, tenantId);
  try {
    await servicePost("reconciliation", "/reconciliation/matched", { payment: settlingPayment }, { tenantId });
    await recordAttempt(paymentId, jobId, "reconciliation", "success", null, tenantId);
  } catch (error) {
    await recordAttempt(paymentId, jobId, "reconciliation", "error", error.message, tenantId);
    throw error;
  }

  // Step 5: Settle
  await recordAttempt(paymentId, jobId, "settlement", "started", null, tenantId);
  const settledAt = payment.settledAt || new Date().toISOString();
  await query(
    PB,
    "UPDATE payment.payments SET status = 'Settled', settled_at = $1 WHERE id = $2 AND tenant_id = $3",
    [settledAt, paymentId, tenantId]
  );
  await recordAttempt(paymentId, jobId, "settlement", "success", null, tenantId);

  // Emit settlement audit event via outbox
  await query(
    PB,
    `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'payment', $2, 'audit.event_recorded', $3)`,
    [
      tenantId,
      paymentId,
      JSON.stringify({
        actor: "Arcadia Custody Bank",
        action: "Payment settled",
        object: payment.reference,
        detail: `Provider reference ${providerRef}`
      })
    ]
  );

  // V6 Epic 5.2, OPT-IN: the simulated rail emits a single-line provider statement on
  // settlement so the full settle → ingest → match path runs end to end without a
  // partner. Default OFF: enabling it would add a statement-confirmed match per
  // settlement and change demo/test reconciliation counts.
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
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "simulated_statement_emit_failed", message: error.message }));
    }
  }
}

async function getPaymentContext(payment, tenantId = DEFAULT_TENANT_ID) {
  const wallet = await serviceGet("wallet", `/wallets/${payment.sourceWalletId}`, { tenantId });
  const entity = await serviceGet("wallet", `/entities/${wallet.entityId}`, { tenantId });
  const asset = await serviceGet("wallet", `/assets/${payment.asset}`, { tenantId });
  const counterparty = await serviceGet("compliance", `/counterparties/${payment.counterpartyId}`, { tenantId });
  const provider = await serviceGet("operations", `/providers/${wallet.providerId}`, { tenantId });
  const wallets = await serviceGet("wallet", "/wallets", { tenantId });
  return { wallet, wallets, entity, asset, counterparty, provider, providerId: wallet.providerId };
}

function fromPaymentRow(row) {
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
    memo: row.memo
  };
}

async function recordAttempt(paymentId, jobId, step, outcome, error = null, tenantId = DEFAULT_TENANT_ID) {
  await query(
    "payment",
    `INSERT INTO payment.payment_execution_attempts (tenant_id, payment_id, job_id, step, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, paymentId, jobId, step, outcome, error]
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  running = false;
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "job_worker_shutdown", workerId: WORKER_ID }));
  setTimeout(() => process.exit(0), 500);
}

// Start polling after all handlers are registered. The while loop must come last because
// top-level infinite loops in ES modules block subsequent code from executing.
console.log(JSON.stringify({ at: new Date().toISOString(), event: "job_worker_started", workerId: WORKER_ID }));

// Schedule periodic sweeper jobs (idempotency cleanup every 6h, auto-expiry every 1h).
// The job worker picks these up and runs the registered handlers.
import("./scheduler.mjs").then((mod) => mod.schedulePeriodicJobs());

while (running) {
  try {
    const jobs = await claimJobs(WORKER_ID, BATCH_LIMIT);
    metrics.claimed += jobs.length;
    if (jobs.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    for (const job of jobs) {
      const startedAt = Date.now();
      const handler = handlers[job.type];
      if (!handler) {
        metrics.noHandler++;
        console.warn(JSON.stringify({
          at: new Date().toISOString(),
          event: "job_no_handler",
          jobId: job.id,
          type: job.type
        }));
        await completeJob(job.id, { attemptNo: job.attempts, durationMs: Date.now() - startedAt });
        continue;
      }
      try {
        await handler(job);
        metrics.completed++;
        await completeJob(job.id, { attemptNo: job.attempts, durationMs: Date.now() - startedAt });
      } catch (error) {
        metrics.failed++;
        if (job.attempts + 1 >= job.max_attempts) metrics.deadLettered++;
        console.error(JSON.stringify({
          at: new Date().toISOString(),
          event: "job_failed",
          jobId: job.id,
          type: job.type,
          message: error.message
        }));
        await failJob(job.id, error.message, { maxAttempts: job.max_attempts });
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "job_worker_cycle_error",
      message: error.message
    }));
    await sleep(Math.min(POLL_INTERVAL_MS * 4, 5000));
  }
}
