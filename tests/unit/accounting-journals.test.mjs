import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBalanced, createPaymentJournals } from "../../services/accounting-service/src/journals.mjs";

const entity = { id: "ent-de" };
const asset = { currency: "EUR" };

test("createPaymentJournals produces a balanced batch including the fee", () => {
  const payment = { id: "pay-1", amount: 1000, fee: 2.5, type: "Supplier", asset: "EURC" };
  const entries = createPaymentJournals(payment, null, entity, asset);
  const debit = entries.reduce((sum, e) => sum + e.debit, 0);
  const credit = entries.reduce((sum, e) => sum + e.credit, 0);
  assert.equal(debit, credit);
  assert.equal(credit, 1002.5);
});

test("createPaymentJournals labels intra-group payments as intercompany receivable", () => {
  const payment = { id: "pay-2", amount: 500, fee: 0, type: "Intra-group", asset: "EURC" };
  const entries = createPaymentJournals(payment, null, entity, asset);
  assert.ok(entries.some((e) => e.account === "Intercompany receivable"));
});

test("createPaymentJournals labels supplier payments as supplier payable", () => {
  const payment = { id: "pay-3", amount: 500, fee: 0, type: "Supplier", asset: "EURC" };
  const entries = createPaymentJournals(payment, null, entity, asset);
  assert.ok(entries.some((e) => e.account === "Supplier payable"));
});

test("createPaymentJournals rejects non-finite or non-positive amount", () => {
  assert.throws(() => createPaymentJournals({ id: "p", amount: NaN, fee: 0, asset: "EURC" }, null, entity, asset));
  assert.throws(() => createPaymentJournals({ id: "p", amount: 0, fee: 0, asset: "EURC" }, null, entity, asset));
  assert.throws(() => createPaymentJournals({ id: "p", amount: -5, fee: 0, asset: "EURC" }, null, entity, asset));
});

test("createPaymentJournals rejects a negative fee", () => {
  assert.throws(() => createPaymentJournals({ id: "p", amount: 5, fee: -1, asset: "EURC" }, null, entity, asset));
});

test("assertBalanced accepts a balanced batch", () => {
  assert.doesNotThrow(() =>
    assertBalanced([
      { debit: 0, credit: 100 },
      { debit: 100, credit: 0 }
    ])
  );
});

test("assertBalanced rejects an unbalanced batch", () => {
  assert.throws(() =>
    assertBalanced([
      { debit: 0, credit: 100 },
      { debit: 90, credit: 0 }
    ])
  );
});
