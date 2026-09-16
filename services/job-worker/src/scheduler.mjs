import { enqueueJob } from "../../../packages/shared/jobs.mjs";
import { logError } from "../../../packages/shared/log.mjs";

// Job type, repeat interval, initial delay. An interval <= 0 disables the job entirely
// (tests use that to run without the watchdog).
const SCHEDULES = [
  ["idempotency-sweep", 6 * 60 * 60 * 1000, 0],
  ["payment-auto-expiry", 60 * 60 * 1000, 0],
  ["ops-watchdog", Number(process.env.WATCHDOG_INTERVAL_MS || 60000), 5000],
  ["audit-chain-verify", Number(process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS || 24 * 60 * 60 * 1000), 0]
];

// Enqueue each periodic job immediately, then repeat on its interval.
export function schedulePeriodicJobs() {
  for (const [type, intervalMs, delayMs] of SCHEDULES) {
    if (intervalMs <= 0) continue;
    const enqueue = () => {
      enqueueJob(type, {}, { maxAttempts: 1, delayMs }).catch((error) => logError(`scheduler_${type}_failed`, error));
    };
    enqueue();
    setInterval(enqueue, intervalMs).unref();
  }
}
