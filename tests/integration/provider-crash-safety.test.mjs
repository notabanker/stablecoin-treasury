import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

const TENANT_1 = "00000000-0000-0000-0000-000000000001";

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

async function login(baseUrl, email) {
  return api(baseUrl, "/login", { method: "POST", body: JSON.stringify({ email, password: "demo123" }) });
}

// Short-lived connection per call -- see the outbox-dlq.test.mjs / auth-rbac.test.mjs lesson
// (57P01 "terminating connection due to administrator command" from a long-lived probe).
async function withDb(connectionString, fn) {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// V8 Task 0.3.6 (Gate G1, Finding 1 -- CRITICAL): before this fix, a crash (or an ambiguous
// throw -- network timeout, process death) between the provider accepting a transfer and this
// process persisting provider_ref meant a retry called adapter.submitTransfer() again with no
// idempotency key. On a real rail that creates a second, duplicate external transfer.
test("provider crash-then-retry reuses the same idempotency key instead of duplicating the external submission", async (t) => {
  const stack = await startStack({ extraEnv: { CUSTODY_TEST_CRASH_ADAPTER: "true" } });
  t.after(() => stack.stop());
  const db = stack._env.DATABASE_URL;

  await withDb(db, (client) => client.query(
    "UPDATE operations.providers SET adapter = 'crash-once-then-idempotent' WHERE id = 'prov-arcadia' AND tenant_id = $1",
    [TENANT_1]
  ));

  const adminLogin = await login(stack.baseUrl, "marta@vega-industries.com");
  const approverLogin = await login(stack.baseUrl, "approver@vega-industries.com");
  assert.equal(adminLogin.status, 200);
  assert.equal(approverLogin.status, 200);
  const adminHeaders = { Authorization: `Bearer ${adminLogin.data.session.token}` };
  const approverHeaders = { Authorization: `Bearer ${approverLogin.data.session.token}` };

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...adminHeaders, "Idempotency-Key": "crash-safety-probe" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const paymentId = create.data.payment.id;

  const approve = await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST", headers: approverHeaders });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));

  // First execute: the crash adapter throws on its first call, after internally recording the
  // transfer as "accepted by the provider" under the deterministic idempotency key.
  const firstExecute = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST", headers: adminHeaders });
  assert.equal(firstExecute.status, 200, JSON.stringify(firstExecute.data));

  const afterFirstAttempt = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query(
      "SELECT status, provider_ref, last_error FROM payment.provider_submissions WHERE tenant_id = $1 AND payment_id = $2",
      [TENANT_1, paymentId]
    );
    return rows[0]?.status === "failed" ? rows[0] : null;
  }));
  assert.equal(afterFirstAttempt.provider_ref, null, "the failed first attempt must not persist a provider_ref");
  assert.ok(afterFirstAttempt.last_error, "the failed attempt must record last_error");

  const failedState = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query("SELECT status, provider_ref FROM payment.payments WHERE id = $1", [paymentId]);
    return rows[0]?.status === "Failed" ? rows[0] : null;
  }));
  assert.ok(!failedState.provider_ref, "payment.payments must not have a provider_ref from the crashed attempt");

  // Retry via the existing repair path (Failed -> Executing -> saga re-runs). The saga re-enters
  // Step 2, sees the SAME provider_submissions row (still keyed by payment:<id>), and calls
  // submitTransfer again with that same idempotency key -- the crash adapter recognizes it and
  // returns the already-accepted result instead of throwing (or creating a distinct transfer).
  const repairRetry = await api(stack.baseUrl, `/repair/${paymentId}/retry`, { method: "POST", headers: adminHeaders });
  assert.equal(repairRetry.status, 200, JSON.stringify(repairRetry.data));

  const settled = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query("SELECT status, provider_ref FROM payment.payments WHERE id = $1", [paymentId]);
    return rows[0]?.status === "Settled" ? rows[0] : null;
  }));

  // Deterministic proof of reuse: the crash adapter derives providerRef purely from the
  // idempotency key (CRASH-<key>). This value only matches if the retry used the exact same
  // key the crashed first attempt recorded as accepted -- not a fresh submission.
  assert.equal(settled.provider_ref, `CRASH-payment:${paymentId}`);

  const finalSubmission = await withDb(db, async (client) => {
    const { rows } = await client.query(
      "SELECT status, provider_ref FROM payment.provider_submissions WHERE tenant_id = $1 AND payment_id = $2",
      [TENANT_1, paymentId]
    );
    return rows[0];
  });
  assert.equal(finalSubmission.status, "submitted");
  assert.equal(finalSubmission.provider_ref, `CRASH-payment:${paymentId}`);
});

// V8 Task 0.3.5 (Finding 1, second failure mode): once the provider has accepted a transfer,
// a downstream failure must not silently mark the payment Failed -- that would lose the fact
// that external money already moved. It must stay Executing, visible on GET /api/repair.
test("a debit failure after the provider already accepted the transfer leaves the payment repairable, not silently Failed", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const db = stack._env.DATABASE_URL;

  const adminLogin = await login(stack.baseUrl, "marta@vega-industries.com");
  const approverLogin = await login(stack.baseUrl, "approver@vega-industries.com");
  const adminHeaders = { Authorization: `Bearer ${adminLogin.data.session.token}` };
  const approverHeaders = { Authorization: `Bearer ${approverLogin.data.session.token}` };

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...adminHeaders, "Idempotency-Key": "divergent-state-probe" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const paymentId = create.data.payment.id;

  const approve = await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST", headers: approverHeaders });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));

  // Force the ledger debit to fail deterministically -- no draining, no balance math -- by
  // suspending the source wallet after approval. The provider adapter itself never checks
  // wallet status, so Step 2 (provider submission) still succeeds; only Step 3 (debit) fails.
  await withDb(db, (client) => client.query(
    "UPDATE wallet.wallets SET status = 'Suspended' WHERE id = 'wal-de-eur' AND tenant_id = $1",
    [TENANT_1]
  ));

  const execute = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST", headers: adminHeaders });
  assert.equal(execute.status, 200, JSON.stringify(execute.data));

  const attempts = await waitFor(async () => {
    const result = await api(stack.baseUrl, `/payments/${paymentId}/attempts`, { headers: adminHeaders });
    const debitError = result.data?.attempts?.find((a) => a.step === "ledger_debit" && a.outcome === "error");
    return debitError || null;
  });
  assert.match(attempts.error, /wallet_inactive|not active|Suspended/i);

  const payment = await withDb(db, async (client) => {
    const { rows } = await client.query("SELECT status, provider_ref FROM payment.payments WHERE id = $1", [paymentId]);
    return rows[0];
  });
  assert.equal(payment.status, "Executing", "must stay Executing, not be marked Failed, once the provider already accepted the transfer");
  assert.ok(payment.provider_ref, "provider_ref must remain recorded -- external state must not be lost");

  const repairList = await api(stack.baseUrl, "/repair", { headers: adminHeaders });
  assert.ok(repairList.data.some((item) => item.payment.id === paymentId), "must appear on the repair list, not disappear as a lost Failed payment");
});
