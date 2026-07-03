import { createHash } from "node:crypto";

export function hashRequest(input) {
  const canonical = JSON.stringify(sortKeys(input ?? {}));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Must be called synchronously, before any `await`, by the caller. The check-then-set here
// runs to completion in a single JS turn, so two request handlers racing on the same key
// cannot both observe "not reserved" -- Node's event loop only interleaves at await/microtask
// boundaries, and this function never yields.
export function reserveIdempotencyKey(store, key, requestHash) {
  const existing = store.state.idempotency[key];
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { outcome: "hash_mismatch" };
    }
    if (existing.status === "pending") {
      return { outcome: "in_progress" };
    }
    return { outcome: "done", paymentId: existing.paymentId };
  }
  store.state.idempotency[key] = { status: "pending", requestHash, at: new Date().toISOString() };
  store.save();
  return { outcome: "reserved" };
}

export function completeIdempotencyKey(store, key, paymentId) {
  if (!key) return;
  // Preserve requestHash: reserveIdempotencyKey compares it against future replays under this
  // key, and dropping it here would make every completed key look mismatched on next use.
  const existing = store.state.idempotency[key];
  store.state.idempotency[key] = { status: "done", paymentId, requestHash: existing?.requestHash, at: new Date().toISOString() };
  store.save();
}

export function releaseIdempotencyKey(store, key) {
  if (!key) return;
  delete store.state.idempotency[key];
  store.save();
}

// Also synchronous/atomic for the same reason as reserveIdempotencyKey above: called before
// any await in createPayment, so concurrent creates can never observe and increment the same
// counter value.
export function allocateReference(store) {
  const current = Number.isFinite(store.state.referenceCounter) ? store.state.referenceCounter : 1000;
  const next = current + 1;
  store.state.referenceCounter = next;
  store.save();
  return `PMT-${next}`;
}
