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

test("full payment lifecycle settles with balanced journals and a matched recon row", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const state0 = await api(stack.baseUrl, "/state");
  const walletBefore = state0.data.wallets.find((w) => w.id === "wal-hold-eur");

  // 60000 EUR is above the seed approvalThreshold (50000), so it requires one explicit human
  // approval rather than the auto-approve-below-threshold path -- see ADR-002.
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "lifecycle-1" },
    body: JSON.stringify({ amount: 60000, counterpartyId: "cp-nordic", sourceWalletId: "wal-hold-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.payment.status, "Pending approval");

  const approve = await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" });
  assert.equal(approve.data.payment.status, "Approved");

  const execute = await api(stack.baseUrl, `/payments/${create.data.payment.id}/execute`, { method: "POST" });
  assert.equal(execute.data.payment.status, "Settled");

  const finalState = execute.data.state;
  const walletAfter = finalState.wallets.find((w) => w.id === "wal-hold-eur");
  const journalLines = finalState.journalEntries.filter((e) => e.paymentId === create.data.payment.id);
  const reconRows = finalState.reconciliation.filter((r) => r.paymentId === create.data.payment.id);

  assert.equal(journalLines.length, 3);
  const debit = journalLines.reduce((sum, e) => sum + e.debit, 0);
  const credit = journalLines.reduce((sum, e) => sum + e.credit, 0);
  assert.equal(debit, credit);
  assert.equal(reconRows.length, 1);
  assert.equal(reconRows[0].issue, "Matched");
  assert.equal(roundTo2(walletBefore.balance - walletAfter.balance), roundTo2(create.data.payment.amount + create.data.payment.fee));
});

test("resuming execute from Executing does not double-debit the wallet", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "lifecycle-resume-1" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" });

  const first = await api(stack.baseUrl, `/payments/${create.data.payment.id}/execute`, { method: "POST" });
  assert.equal(first.data.payment.status, "Settled");
  const walletAfterFirst = first.data.state.wallets.find((w) => w.id === "wal-de-eur");

  const second = await api(stack.baseUrl, `/payments/${create.data.payment.id}/execute`, { method: "POST" });
  assert.equal(second.data.payment.status, "Settled");
  const walletAfterSecond = second.data.state.wallets.find((w) => w.id === "wal-de-eur");

  assert.equal(walletAfterFirst.balance, walletAfterSecond.balance);
});

test("blocked counterparty payments never reach execution", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-baltic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.data.payment.status, "Blocked");

  const approve = await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" });
  assert.equal(approve.status, 409);
});

test("a counterparty under review blocks approval with 409 review_required", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-orion", sourceWalletId: "wal-nl-usd", type: "Supplier" })
  });
  assert.equal(create.data.payment.status, "Pending approval");

  const approve = await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, { method: "POST" });
  assert.equal(approve.status, 409);
  assert.equal(approve.data.error, "review_required");
});

test("payments over the hard transfer limit are blocked even with sufficient balance", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    body: JSON.stringify({ amount: 800000, counterpartyId: "cp-nordic", sourceWalletId: "wal-hold-eur", type: "Supplier" })
  });
  assert.equal(create.data.payment.status, "Blocked");
});

test("replaying an Idempotency-Key returns the original payment without creating a duplicate", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const first = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "replay-1" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const second = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "replay-1" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });

  assert.equal(first.data.payment.id, second.data.payment.id);
  const state = await api(stack.baseUrl, "/state");
  const matches = state.data.payments.filter((p) => p.sourceWalletId === "wal-de-eur" && p.amount === 1000);
  assert.equal(matches.length, 1);
});

test("reusing an Idempotency-Key with a different request body is rejected", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "reuse-1" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const second = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "reuse-1" },
    body: JSON.stringify({ amount: 2000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });

  assert.equal(second.status, 422);
  assert.equal(second.data.error, "idempotency_key_reuse");
});

test("wallet debit rejects non-finite, zero, and negative amounts", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Call wallet-service directly (the gateway has no debit route -- debits are internal).
  const walletBaseUrl = `http://127.0.0.1:${stack.ports.wallet}`;
  for (const amount of [Number.NaN, 0, -5]) {
    const response = await fetch(`${walletBaseUrl}/wallets/wal-de-eur/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `bad-${amount}-${Date.now()}-${Math.random()}` },
      body: JSON.stringify({ amount })
    });
    assert.equal(response.status, 422, `amount=${amount} should be rejected`);
  }
  const walletState = await fetch(`${walletBaseUrl}/wallets/wal-de-eur`).then((r) => r.json());
  assert.ok(Number.isFinite(walletState.balance));
});

function roundTo2(value) {
  return Math.round(value * 100) / 100;
}
