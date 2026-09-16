import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { query } from "../../../packages/shared/db.mjs";
import { createMetricsSnapshot } from "../../../packages/shared/metrics.mjs";
import { expireStalePayments, sweepIdempotencyKeys } from "./handlers/expiry.mjs";
import { executePayment } from "./handlers/payment-saga.mjs";
import { verifyChains } from "./handlers/audit-chain.mjs";
import { runWatchdog } from "./handlers/watchdog.mjs";
import { matchStatement, processSettlementWebhook } from "./handlers/webhooks.mjs";
import { startJobQueue } from "./queue.mjs";
import { schedulePeriodicJobs } from "./scheduler.mjs";

validateProductionConfig("job-worker");

const counters = { claimed: 0, completed: 0, failed: 0, deadLettered: 0, noHandler: 0 };

// Money-path metrics cache: the DB query runs at most once per TTL and a failure serves the
// last good snapshot instead of breaking the scrape.
const metricsSnapshot = createMetricsSnapshot(async () => {
  const { rows } = await query("platform",
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS queue_depth,
       COUNT(*) FILTER (WHERE status = 'dead_lettered')::int AS dead_letter_count,
       COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE status = 'pending')) * 1000, 0)::float AS oldest_pending_job_age_ms
     FROM platform.jobs WHERE status IN ('pending', 'dead_lettered')`
  );
  return {
    queueDepth: rows[0]?.queue_depth ?? 0,
    deadLetterCount: rows[0]?.dead_letter_count ?? 0,
    oldestPendingJobAgeMs: Math.round(rows[0]?.oldest_pending_job_age_ms ?? 0)
  };
});

const HANDLERS = {
  "execute-payment": executePayment,
  "payment-auto-expiry": expireStalePayments,
  "idempotency-sweep": sweepIdempotencyKeys,
  "process-settlement-webhook": processSettlementWebhook,
  "match-statement": matchStatement,
  "ops-watchdog": runWatchdog,
  "audit-chain-verify": verifyChains
};

startJobQueue({
  handlers: HANDLERS,
  counters,
  metrics: metricsSnapshot,
  pollIntervalMs: Number(process.env.JOB_POLL_INTERVAL_MS || 500)
});

schedulePeriodicJobs();
