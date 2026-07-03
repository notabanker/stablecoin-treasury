import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "../../services/payment-service/src/idempotency.mjs";
import { requiredApprovalsFor } from "../../services/payment-service/src/approvals.mjs";

function fakeStore(initial = {}) {
  const state = { idempotency: {}, referenceCounter: 1000, ...initial };
  return {
    state,
    save() {
      /* no-op: unit tests only need in-memory state */
    }
  };
}

test("hashRequest is stable regardless of key order", () => {
  const a = hashRequest({ amount: 100, counterpartyId: "cp-1" });
  const b = hashRequest({ counterpartyId: "cp-1", amount: 100 });
  assert.equal(a, b);
});

test("hashRequest differs for different bodies", () => {
  assert.notEqual(hashRequest({ amount: 100 }), hashRequest({ amount: 200 }));
});

test("reserveIdempotencyKey reserves a fresh key", () => {
  const store = fakeStore();
  const result = reserveIdempotencyKey(store, "key-1", "hash-a");
  assert.equal(result.outcome, "reserved");
  assert.equal(store.state.idempotency["key-1"].status, "pending");
});

test("reserveIdempotencyKey reports in_progress for a pending reservation with the same hash", () => {
  const store = fakeStore();
  reserveIdempotencyKey(store, "key-1", "hash-a");
  const second = reserveIdempotencyKey(store, "key-1", "hash-a");
  assert.equal(second.outcome, "in_progress");
});

test("reserveIdempotencyKey reports hash_mismatch for a different body under the same key", () => {
  const store = fakeStore();
  reserveIdempotencyKey(store, "key-1", "hash-a");
  const second = reserveIdempotencyKey(store, "key-1", "hash-b");
  assert.equal(second.outcome, "hash_mismatch");
});

test("reserveIdempotencyKey reports done with the stored paymentId after completion", () => {
  const store = fakeStore();
  reserveIdempotencyKey(store, "key-1", "hash-a");
  completeIdempotencyKey(store, "key-1", "pay-123");
  const result = reserveIdempotencyKey(store, "key-1", "hash-a");
  assert.deepEqual(result, { outcome: "done", paymentId: "pay-123" });
});

test("releaseIdempotencyKey allows a fresh reservation after failure", () => {
  const store = fakeStore();
  reserveIdempotencyKey(store, "key-1", "hash-a");
  releaseIdempotencyKey(store, "key-1");
  const result = reserveIdempotencyKey(store, "key-1", "hash-a");
  assert.equal(result.outcome, "reserved");
});

test("allocateReference increments monotonically and persists across calls", () => {
  const store = fakeStore();
  const first = allocateReference(store);
  const second = allocateReference(store);
  assert.equal(first, "PMT-1001");
  assert.equal(second, "PMT-1002");
});

test("requiredApprovalsFor converts non-EUR assets before comparing thresholds", () => {
  const policy = { approvalThreshold: 50000, secondApprovalThreshold: 250000 };
  // 60000 USDC * 0.92 = 55200 EUR, over the 50000 EUR threshold -> 1 approval.
  assert.equal(requiredApprovalsFor(60000, "USDC", policy), 1);
  assert.equal(requiredApprovalsFor(10000, "USDC", policy), 0);
});
