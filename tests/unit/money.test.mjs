import { test } from "node:test";
import assert from "node:assert/strict";
import { Money, roundMoney } from "../../packages/shared/money.mjs";

test("Money.fromString preserves cent precision", () => {
  const amount = Money.fromString("420.10");
  assert.equal(amount.toString(), "420.10");
  assert.equal(amount.toCents(), 42010n);
});

test("Money.plus avoids float drift", () => {
  const left = Money.fromString("0.10");
  const right = Money.fromString("0.20");
  assert.equal(left.plus(right).toString(), "0.30");
});

test("roundMoney delegates to cent-safe rounding", () => {
  assert.equal(roundMoney(1.006), 1.01);
  assert.equal(roundMoney(1.004), 1);
});