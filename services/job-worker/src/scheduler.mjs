import { enqueueJob } from "../../../packages/shared/jobs.mjs";

const IDEMPOTENCY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AUTO_EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 60000); // 1 minute
const AUDIT_CHAIN_VERIFY_INTERVAL_MS = Number(process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS || 24 * 60 * 60 * 1000); // nightly

export function schedulePeriodicJobs() {
  // Enqueue immediately, then repeat on interval
  enqueueSweeper().catch((e) => console.error("sweeper initial enqueue failed:", e.message));
  enqueueExpiry().catch((e) => console.error("expiry initial enqueue failed:", e.message));
  if (WATCHDOG_INTERVAL_MS > 0) {
    enqueueWatchdog().catch((e) => console.error("watchdog initial enqueue failed:", e.message));
    setInterval(() => enqueueWatchdog().catch(() => {}), WATCHDOG_INTERVAL_MS);
  }
  if (AUDIT_CHAIN_VERIFY_INTERVAL_MS > 0) {
    enqueueAuditChainVerify().catch((e) => console.error("audit-chain-verify initial enqueue failed:", e.message));
    setInterval(() => enqueueAuditChainVerify().catch(() => {}), AUDIT_CHAIN_VERIFY_INTERVAL_MS);
  }

  setInterval(() => enqueueSweeper().catch(() => {}), IDEMPOTENCY_SWEEP_INTERVAL_MS);
  setInterval(() => enqueueExpiry().catch(() => {}), AUTO_EXPIRY_INTERVAL_MS);
}

async function enqueueSweeper() {
  await enqueueJob("idempotency-sweep", {}, { maxAttempts: 1 });
}

async function enqueueExpiry() {
  await enqueueJob("payment-auto-expiry", {}, { maxAttempts: 1 });
}

async function enqueueWatchdog() {
  await enqueueJob("ops-watchdog", {}, { maxAttempts: 1, delayMs: 5000 });
}

async function enqueueAuditChainVerify() {
  await enqueueJob("audit-chain-verify", {}, { maxAttempts: 1 });
}
