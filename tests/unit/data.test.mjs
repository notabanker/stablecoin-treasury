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

test("createId produces unique, prefixed ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => createId("pay")));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.ok(id.startsWith("pay-"));
  }
});
