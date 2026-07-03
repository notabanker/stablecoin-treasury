const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080/api";
const baseUrl = new URL(base);
const readyUrl = new URL("/ready", baseUrl);
const healthUrl = new URL("/health", baseUrl);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!LOOPBACK_HOSTS.has(baseUrl.hostname) && process.env.SMOKE_ALLOW_REMOTE !== "1") {
  throw new Error(
    `Refusing to run smoke test against non-loopback host "${baseUrl.hostname}". ` +
      `This script calls POST /reset, which destroys existing state. ` +
      `Set SMOKE_ALLOW_REMOTE=1 to override once you are certain this target is disposable.`
  );
}

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
    const error = new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function assertRejects(promiseFactory, expectedStatus, label) {
  try {
    await promiseFactory();
  } catch (error) {
    if (expectedStatus && error.status !== expectedStatus) {
      throw new Error(`${label}: expected status ${expectedStatus}, got ${error.status}`);
    }
    return;
  }
  throw new Error(`${label}: expected request to be rejected, but it succeeded`);
}

const healthResponse = await fetch(healthUrl);
const health = await healthResponse.json();
if (health.service !== "api-gateway") {
  throw new Error(`Target at ${base} does not look like this app's gateway (got service="${health.service}")`);
}

const readyResponse = await fetch(readyUrl);
const ready = await readyResponse.json();
if (Object.values(ready).some((status) => status !== "ok")) {
  throw new Error(`Readiness failed: ${JSON.stringify(ready)}`);
}

await req("/reset", { method: "POST" });
const initial = await req("/state");
const initialWallet = initial.wallets.find((wallet) => wallet.id === "wal-hold-eur");
const idempotencyKey = `smoke-${Date.now()}`;

// --- Happy path: create, idempotent replay, approve, execute, settle ---
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
// Execution is now async (saga picks up the job and settles). Poll for settlement.
if (!executed.accepted) {
  throw new Error(`Execute should be accepted, got ${JSON.stringify(executed)}`);
}

let payment;
let state;
for (let i = 0; i < 50; i++) {
  state = await req("/state");
  payment = state.payments.find((item) => item.id === created.payment.id);
  if (payment && (payment.status === "Settled" || payment.status === "Failed")) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (payment.status !== "Settled") {
  throw new Error(`Expected settled payment after saga, got ${payment.status}`);
}

const wallet = state.wallets.find((item) => item.id === "wal-hold-eur");
const journalLines = state.journalEntries.filter((entry) => entry.paymentId === created.payment.id);
const reconRows = state.reconciliation.filter((entry) => entry.paymentId === created.payment.id);
if (journalLines.length !== 3) {
  throw new Error(`Expected 3 journal lines, got ${journalLines.length}`);
}
if (!reconRows.length) {
  throw new Error("Expected reconciliation row");
}
if (wallet.balance >= initialWallet.balance) {
  throw new Error("Expected source wallet balance to decrease");
}

// --- Failure path: blocked counterparty is blocked outright ---
const blockedCounterparty = await req("/payments", {
  body: JSON.stringify({
    amount: 1000,
    counterpartyId: "cp-baltic",
    memo: "Smoke: blocked counterparty",
    sourceWalletId: "wal-de-eur",
    type: "Supplier"
  }),
  idempotencyKey: `smoke-blocked-${Date.now()}`,
  method: "POST"
});
if (blockedCounterparty.payment.status !== "Blocked") {
  throw new Error(`Expected blocked-counterparty payment to be Blocked, got ${blockedCounterparty.payment.status}`);
}

// --- Failure path: amount over the hard transfer limit is blocked ---
const overLimit = await req("/payments", {
  body: JSON.stringify({
    amount: 800000,
    counterpartyId: "cp-nordic",
    memo: "Smoke: over hard transfer limit",
    sourceWalletId: "wal-hold-eur",
    type: "Supplier"
  }),
  idempotencyKey: `smoke-overlimit-${Date.now()}`,
  method: "POST"
});
if (overLimit.payment.status !== "Blocked") {
  throw new Error(`Expected over-limit payment to be Blocked, got ${overLimit.payment.status}`);
}

// --- Failure path: a counterparty under compliance review cannot be approved ---
const underReview = await req("/payments", {
  body: JSON.stringify({
    amount: 5000,
    counterpartyId: "cp-orion",
    memo: "Smoke: counterparty under review",
    sourceWalletId: "wal-nl-usd",
    type: "Supplier"
  }),
  idempotencyKey: `smoke-review-${Date.now()}`,
  method: "POST"
});
if (underReview.payment.status !== "Pending approval") {
  throw new Error(`Expected under-review payment to stay Pending approval, got ${underReview.payment.status}`);
}
await assertRejects(
  () => req(`/payments/${underReview.payment.id}/approve`, { method: "POST" }),
  409,
  "Approving a payment to a counterparty under review should be rejected"
);

// --- Failure path: reusing an Idempotency-Key with a different body is rejected ---
const reuseKey = `smoke-reuse-${Date.now()}`;
await req("/payments", {
  body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" }),
  idempotencyKey: reuseKey,
  method: "POST"
});
await assertRejects(
  () =>
    req("/payments", {
      body: JSON.stringify({ amount: 999, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" }),
      idempotencyKey: reuseKey,
      method: "POST"
    }),
  422,
  "Reusing an Idempotency-Key with a different request body should be rejected"
);

await req("/reset", { method: "POST" });
console.log(
  JSON.stringify({
    status: "ok",
    payment: payment.reference,
    journalLines: journalLines.length,
    reconRows: reconRows.length,
    failurePathsVerified: ["blocked_counterparty", "over_hard_limit", "review_blocks_approval", "idempotency_key_reuse"]
  })
);
