import { test } from "node:test";
import assert from "node:assert/strict";
import { Money, moneyNumber, parseMoneyInput, roundMoney } from "../../packages/shared/money.mjs";

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

test("Money.fromNumeric accepts Postgres-style numeric strings", () => {
  assert.equal(Money.fromNumeric("1000.50").toNumber(), 1000.5);
  assert.equal(Money.fromNumeric(null), null);
});

test("moneyNumber maps pg numerics and numbers at cent precision", () => {
  assert.equal(moneyNumber("0.10"), 0.1);
  assert.equal(moneyNumber("0.20"), 0.2);
  assert.equal(moneyNumber(42), 42);
  assert.equal(moneyNumber(null), 0);
  // classic float trap: 0.1 + 0.2 via Money stays exact after round-trip
  assert.equal(Money.fromString("0.10").plus(Money.fromString("0.20")).toNumber(), 0.3);
});

test("parseMoneyInput accepts numbers and decimal strings", () => {
  assert.equal(parseMoneyInput(1000).toNumber(), 1000);
  assert.equal(parseMoneyInput("1,234.56").toNumber(), 1234.56);
  assert.equal(parseMoneyInput("12.40").toString(), "12.40");
});

test("parseMoneyInput rejects empty and non-numeric input", () => {
  assert.throws(() => parseMoneyInput(""), RangeError);
  assert.throws(() => parseMoneyInput(null), RangeError);
  assert.throws(() => parseMoneyInput("abc"), RangeError);
  assert.throws(() => parseMoneyInput(NaN), RangeError);
});

test("roundMoney delegates to cent-safe rounding", () => {
  assert.equal(roundMoney(1.006), 1.01);
  assert.equal(roundMoney(1.004), 1);
});
