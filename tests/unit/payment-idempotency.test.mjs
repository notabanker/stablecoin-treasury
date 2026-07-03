import { test } from "node:test";
import assert from "node:assert/strict";
import { hashRequest } from "../../services/payment-service/src/idempotency.mjs";
import { requiredApprovalsFor } from "../../services/payment-service/src/approvals.mjs";

test("hashRequest is stable regardless of key order", () => {
  const a = hashRequest({ amount: 100, counterpartyId: "cp-1" });
  const b = hashRequest({ counterpartyId: "cp-1", amount: 100 });
  assert.equal(a, b);
});

test("hashRequest differs for different bodies", () => {
  assert.notEqual(hashRequest({ amount: 100 }), hashRequest({ amount: 200 }));
});

test("requiredApprovalsFor converts non-EUR assets before comparing thresholds", () => {
  const policy = { approvalThreshold: 50000, secondApprovalThreshold: 250000 };
  // 60000 USDC * 0.92 = 55200 EUR, over the 50000 EUR threshold -> 1 approval.
  assert.equal(requiredApprovalsFor(60000, "USDC", policy), 1);
  assert.equal(requiredApprovalsFor(10000, "USDC", policy), 0);
});
