import { test } from "node:test";
import assert from "node:assert/strict";
import { createId, estimateFee, nextPaymentReference, roundMoney } from "../../packages/shared/data.mjs";

test("roundMoney rounds to 2 decimal places", () => {
  assert.equal(roundMoney(1.006), 1.01);
  assert.equal(roundMoney(1.004), 1);
  assert.equal(roundMoney(0), 0);
  assert.equal(roundMoney("42.999"), 43);
});

test("estimateFee is positive and asset-dependent", () => {
  const eurFee = estimateFee(1000, "EURC");
  const usdFee = estimateFee(1000, "USDC");
  assert.ok(eurFee > 0);
  assert.ok(usdFee > 0);
  assert.notEqual(eurFee, usdFee);
});

test("nextPaymentReference increments from the highest existing reference", () => {
  const payments = [{ reference: "PMT-1001" }, { reference: "PMT-1050" }, { reference: "PMT-1002" }];
  assert.equal(nextPaymentReference(payments), "PMT-1051");
});

test("nextPaymentReference defaults sanely on empty input", () => {
  assert.equal(nextPaymentReference([]), "PMT-1001");
});

test("createId produces unique, prefixed, UUID-backed ids", () => {
  const uuidBody = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = new Set(Array.from({ length: 200 }, () => createId("pay")));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.ok(id.startsWith("pay-"));
    assert.ok(uuidBody.test(id.slice("pay-".length)), `expected UUID body in ${id}`);
  }
});

test("estimateFee is cent-stable for common amounts", () => {
  // 1000 * 0.00009 = 0.09 → EURC fee = 2.40 + 0.09 = 2.49
  assert.equal(estimateFee(1000, "EURC"), 2.49);
  assert.equal(estimateFee("1000", "EURC"), 2.49);
  // USDC base 3.20 + 0.09 = 3.29
  assert.equal(estimateFee(1000, "USDC"), 3.29);
});
