import { enqueueJob } from "../../../packages/shared/jobs.mjs";

const IDEMPOTENCY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AUTO_EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function schedulePeriodicJobs() {
  // Enqueue immediately, then repeat on interval
  enqueueSweeper().catch((e) => console.error("sweeper initial enqueue failed:", e.message));
  enqueueExpiry().catch((e) => console.error("expiry initial enqueue failed:", e.message));

  setInterval(() => enqueueSweeper().catch(() => {}), IDEMPOTENCY_SWEEP_INTERVAL_MS);
  setInterval(() => enqueueExpiry().catch(() => {}), AUTO_EXPIRY_INTERVAL_MS);
}

async function enqueueSweeper() {
  await enqueueJob("idempotency-sweep", {}, { maxAttempts: 1 });
}

async function enqueueExpiry() {
  await enqueueJob("payment-auto-expiry", {}, { maxAttempts: 1 });
}
