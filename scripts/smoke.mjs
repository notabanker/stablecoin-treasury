const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080/api";

async function req(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text}`);
  }
  return data;
}

const readyResponse = await fetch(base.replace("/api", "/ready"));
const ready = await readyResponse.json();
if (Object.values(ready).some((status) => status !== "ok")) {
  throw new Error(`Readiness failed: ${JSON.stringify(ready)}`);
}

await req("/reset", { method: "POST" });
const initial = await req("/state");
const initialWallet = initial.wallets.find((wallet) => wallet.id === "wal-hold-eur");
const idempotencyKey = `smoke-${Date.now()}`;
const created = await req("/payments", {
  body: JSON.stringify({
    amount: 25000,
    counterpartyId: "cp-nordic",
    memo: "Production smoke test",
    sourceWalletId: "wal-hold-eur",
    type: "Supplier"
  }),
  idempotencyKey,
  method: "POST"
});
const replayed = await req("/payments", {
  body: JSON.stringify({
    amount: 25000,
    counterpartyId: "cp-nordic",
    memo: "Production smoke test",
    sourceWalletId: "wal-hold-eur",
    type: "Supplier"
  }),
  idempotencyKey,
  method: "POST"
});
if (created.payment.id !== replayed.payment.id) {
  throw new Error("Payment creation idempotency failed");
}

await req(`/payments/${created.payment.id}/approve`, { method: "POST" });
const executed = await req(`/payments/${created.payment.id}/execute`, { method: "POST" });
const state = executed.state;
const payment = state.payments.find((item) => item.id === created.payment.id);
const wallet = state.wallets.find((item) => item.id === "wal-hold-eur");
const journalLines = state.journalEntries.filter((entry) => entry.paymentId === created.payment.id);
const reconRows = state.reconciliation.filter((entry) => entry.paymentId === created.payment.id);

if (payment.status !== "Settled") {
  throw new Error(`Expected settled payment, got ${payment.status}`);
}
if (journalLines.length !== 3) {
  throw new Error(`Expected 3 journal lines, got ${journalLines.length}`);
}
if (!reconRows.length) {
  throw new Error("Expected reconciliation row");
}
if (wallet.balance >= initialWallet.balance) {
  throw new Error("Expected source wallet balance to decrease");
}

await req("/reset", { method: "POST" });
console.log(JSON.stringify({ status: "ok", payment: payment.reference, journalLines: journalLines.length, reconRows: reconRows.length }));

