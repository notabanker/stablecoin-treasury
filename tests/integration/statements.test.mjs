import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TENANT_ID, api, waitFor } from "../helpers/api.mjs";
import { startStack } from "../helpers/stack.mjs";

// Statement-specific service-port helper: statements are ingested directly against the
// reconciliation service, not through the gateway.
function reconApi(stack, path, options = {}) {
  return fetch(`http://127.0.0.1:${stack.ports.reconciliation}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Tenant-Id": DEFAULT_TENANT_ID, ...(options.headers || {}) }
  });
}

async function settlePayment(stack, idempotencyKey, amount = 5000) {
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ amount, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;
  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });
  await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });

  return waitFor(async () => {
    const state = await api(stack.baseUrl, "/state");
    const payment = state.data.payments?.find((p) => p.id === paymentId);
    if (payment?.status === "Settled") return payment;
    if (payment?.status === "Failed" || payment?.status === "Blocked") {
      throw new Error(`Payment ${paymentId} ended ${payment.status}`);
    }
    return null;
  }, { timeoutMs: 15000, label: `payment ${paymentId} to settle` });
}

async function waitForMatch(stack, statementId, timeoutMs = 15000) {
  return waitFor(async () => {
    const res = await reconApi(stack, "/statements");
    const statements = await res.json();
    const statement = statements.find((s) => s.id === statementId);
    if (statement && statement.lineCount > 0 && statement.matchedCount + statement.exceptionCount === statement.lineCount) {
      return statement;
    }
    return null;
  }, { timeoutMs, intervalMs: 300, label: `statement ${statementId} to be fully matched` });
}

test("statement ingestion matches exact refs and opens categorized exceptions", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const p1 = await settlePayment(stack, "stmt-e2e-1", 5000);
  const p2 = await settlePayment(stack, "stmt-e2e-2", 7000);
  assert.ok(p1.providerRef && p2.providerRef, "settled payments must carry provider refs");

  // Validation: statements without lines are rejected.
  const empty = await reconApi(stack, "/statements", { method: "POST", body: JSON.stringify({ providerId: "prov-arcadia", externalId: "stmt-empty", lines: [] }) });
  assert.equal(empty.status, 422);

  const ingest = await reconApi(stack, "/statements", {
    method: "POST",
    body: JSON.stringify({
      providerId: "prov-arcadia",
      externalId: "stmt-e2e-A",
      lines: [
        { providerRef: p1.providerRef, amount: p1.amount, asset: p1.asset },
        { providerRef: p2.providerRef, amount: p2.amount + 123.45, asset: p2.asset },
        { providerRef: "ARC-UNKNOWN-REF", amount: 999, asset: "EURC" }
      ]
    })
  });
  const ingested = await ingest.json();
  assert.equal(ingest.status, 200);
  assert.equal(ingested.status, "ingested");

  // The match-statement durable job (enqueued at ingestion) drives the matching.
  const matched = await waitForMatch(stack, ingested.statementId);
  assert.equal(matched.matchedCount, 1, "exact provider_ref + amount must match");
  assert.equal(matched.exceptionCount, 2, "amount mismatch and unknown ref must both be exceptions");

  const recon = await api(stack.baseUrl, "/state");
  const issues = recon.data.reconciliation.map((r) => r.issue);
  assert.ok(issues.includes("Amount differs from provider statement"), "amount_mismatch exception row expected");
  assert.ok(issues.includes("Statement line has no matching payment"), "missing_ours exception row expected");

  // Idempotent re-delivery of the same statement.
  const replay = await reconApi(stack, "/statements", {
    method: "POST",
    body: JSON.stringify({
      providerId: "prov-arcadia",
      externalId: "stmt-e2e-A",
      lines: [{ providerRef: "ARC-REPLAYED", amount: 1, asset: "EURC" }]
    })
  });
  const replayed = await replay.json();
  assert.equal(replayed.status, "duplicate", "same (provider, externalId) must be a no-op");
  const after = await reconApi(stack, "/statements");
  const statements = await after.json();
  assert.equal(statements.length, 1, "replay must not create a second statement");
  assert.equal(statements[0].lineCount, 3, "replay must not add lines");

  // Demo reset must survive the new FK chain (statement_lines -> provider_statements).
  const reset = await api(stack.baseUrl, "/reset", { method: "POST", body: "{}" });
  assert.equal(reset.status, 200, "reset must handle statement tables' FK order");
});

test("statements with a declared period flag settled payments missing from them", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const p1 = await settlePayment(stack, "stmt-mt-1", 4000);

  const ingest = await reconApi(stack, "/statements", {
    method: "POST",
    body: JSON.stringify({
      providerId: "prov-arcadia",
      externalId: "stmt-mt-A",
      periodStart: new Date(Date.now() - 3600_000).toISOString(),
      periodEnd: new Date(Date.now() + 3600_000).toISOString(),
      lines: [{ providerRef: "ARC-SOMEONE-ELSE", amount: 42, asset: "EURC" }]
    })
  });
  const ingested = await ingest.json();
  await waitForMatch(stack, ingested.statementId);

  const state = await api(stack.baseUrl, "/state");
  const missingTheirs = state.data.reconciliation.find(
    (r) => r.issue === "Settled payment missing from provider statement" && r.paymentId === p1.id
  );
  assert.ok(missingTheirs, "settled payment inside the period but absent from the statement must open a missing_theirs exception");
});

test("SIMULATED_STATEMENT_EMIT drives the full settle -> ingest -> match path", async (t) => {
  const stack = await startStack({ extraEnv: { SIMULATED_STATEMENT_EMIT: "true" } });
  t.after(() => stack.stop());

  const payment = await settlePayment(stack, "stmt-emit-1", 6000);

  const statement = await waitFor(async () => {
    const res = await reconApi(stack, "/statements");
    const statements = await res.json();
    const found = statements.find((s) => s.externalId === `sim-stmt-${payment.providerRef}`);
    return found && found.matchedCount === 1 ? found : null;
  }, { timeoutMs: 15000, intervalMs: 300, label: "simulated statement to be emitted and matched" });
  assert.ok(statement, "settlement must auto-emit a simulated provider statement");
  assert.equal(statement.matchedCount, 1, "the emitted line must match its own payment exactly");
  assert.equal(statement.exceptionCount, 0);
});
