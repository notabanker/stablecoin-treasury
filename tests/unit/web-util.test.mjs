import test from "node:test";
import assert from "node:assert/strict";

// state.js reads document at module scope — stub the bare minimum before import.
globalThis.document = { querySelector: () => ({ innerHTML: "", addEventListener: () => {} }) };

const { computeMetrics, filteredPayments } = await import("../../apps/web/js/util.js");
const { state } = await import("../../apps/web/js/state.js");

test("computeMetrics aggregates the dashboard cards", () => {
  // walletValueEur = Number(wallet.balance) * (ratesToEur[asset] || 1) — no
  // ratesToEur set, so EURC and BTC both count at face value.
  const data = {
    wallets: [
      { asset: "EURC", balance: 100 },
      { asset: "BTC", balance: 300 }
    ],
    payments: [{ status: "Blocked" }, { status: "Pending approval" }],
    providers: [{ status: "Operational" }, { status: "Degraded" }],
    reconciliation: [{ status: "Open" }],
    journalEntries: [{ status: "Ready" }, { status: "Exported" }]
  };
  const m = computeMetrics(data);
  assert.equal(m.blockedPayments, 1);
  assert.equal(m.pendingApprovals, 1);
  assert.equal(m.degradedProviders, 1);
  assert.equal(m.openExceptions, 1);
  assert.equal(m.readyJournals, 1);
  assert.equal(m.eurAssetShare, 0.25); // 100 / (100+300), EURC only
  assert.equal(m.totalEur, 400);
});

test("filteredPayments filters by status and search text", () => {
  state.data = {
    payments: [
      { id: "p1", reference: "PAY-1001", type: "Supplier", asset: "EURC", memo: "invoices", status: "Pending approval", counterpartyId: "c1" },
      { id: "p2", reference: "PAY-1002", type: "Intra-group", asset: "EURC", memo: "transfer", status: "Settled", counterpartyId: "c2" }
    ],
    counterparties: [{ id: "c1", name: "ACME GmbH" }, { id: "c2", name: "Nordic AB" }]
  };
  state.filters.paymentStatus = "All";
  state.filters.paymentSearch = "ACME";
  assert.equal(filteredPayments().length, 1);
  assert.equal(filteredPayments()[0].id, "p1");
  state.filters.paymentSearch = "";
  state.filters.paymentStatus = "Settled";
  assert.equal(filteredPayments().length, 1);
  assert.equal(filteredPayments()[0].id, "p2");
});
