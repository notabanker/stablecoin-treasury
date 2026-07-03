import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

test("N concurrent creates with the same Idempotency-Key produce exactly one payment", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const key = "concurrent-same-key";
  const body = JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => api(stack.baseUrl, "/payments", { method: "POST", headers: { "Idempotency-Key": key }, body }))
  );

  const succeeded = results.filter((r) => r.status === 200);
  assert.ok(succeeded.length >= 1, "at least one request must succeed");
  const paymentIds = new Set(succeeded.map((r) => r.data.payment.id));
  assert.equal(paymentIds.size, 1, `expected exactly one distinct payment id, got ${paymentIds.size}`);

  const state = await api(stack.baseUrl, "/state");
  const matching = state.data.payments.filter((p) => p.sourceWalletId === "wal-de-eur" && p.amount === 1000 && p.counterpartyId === "cp-nordic");
  assert.equal(matching.length, 1, "exactly one payment should exist in the store");
});

test("N concurrent creates with distinct keys all get unique references", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      api(stack.baseUrl, "/payments", {
        method: "POST",
        headers: { "Idempotency-Key": `distinct-${i}` },
        body: JSON.stringify({ amount: 100 + i, counterpartyId: "cp-nordic", sourceWalletId: "wal-hold-eur", type: "Supplier" })
      })
    )
  );

  const succeeded = results.filter((r) => r.status === 200);
  assert.equal(succeeded.length, 25, "all 25 distinct-key creates should succeed");
  const references = succeeded.map((r) => r.data.payment.reference);
  assert.equal(new Set(references).size, 25, "all references must be unique");
});

test("concurrent execute calls on the same payment cannot double-debit the wallet", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "concurrent-execute-1" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" });

  const walletBefore = (await api(stack.baseUrl, "/state")).data.wallets.find((w) => w.id === "wal-de-eur");

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api(stack.baseUrl, `/payments/${create.data.payment.id}/execute`, { method: "POST" }))
  );
  const settled = results.filter((r) => r.status === 200 && r.data.payment.status === "Settled");
  assert.ok(settled.length >= 1);

  const walletAfter = (await api(stack.baseUrl, "/state")).data.wallets.find((w) => w.id === "wal-de-eur");
  const debited = roundTo2(walletBefore.balance - walletAfter.balance);
  const expected = roundTo2(create.data.payment.amount + create.data.payment.fee);
  assert.equal(debited, expected, `expected exactly one debit of ${expected}, observed ${debited}`);
});

test("concurrent approvals cannot push a two-approval payment's count past its requirement", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // 300000 EUR-equivalent exceeds the seed secondApprovalThreshold (250000) -> requires 2 approvals.
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "concurrent-approve-1" },
    body: JSON.stringify({ amount: 300000, counterpartyId: "cp-vega-pl", sourceWalletId: "wal-hold-eur", type: "Intra-group" })
  });
  assert.equal(create.data.payment.requiredApprovals, 2);

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" }))
  );
  const ok = results.filter((r) => r.status === 200);
  assert.ok(ok.length > 0);
  const finalApprovals = ok[ok.length - 1].data.payment.approvals;
  assert.ok(finalApprovals <= 2, `approvals must never exceed requiredApprovals (2), got ${finalApprovals}`);

  const state = await api(stack.baseUrl, "/state");
  const payment = state.data.payments.find((p) => p.id === create.data.payment.id);
  assert.ok(payment.approvals <= 2);
});

function roundTo2(value) {
  return Math.round(value * 100) / 100;
}
