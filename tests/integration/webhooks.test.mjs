import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack } from "../helpers/stack.mjs";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "sandbox-webhook-secret";
const TENANT_1 = "00000000-0000-0000-0000-000000000001";

// Direct DB access to the stack's throwaway database (bypasses RLS as the owner).
function adminDbUrl(stack) {
  const url = new URL(process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres");
  url.pathname = `/${stack.databaseName}`;
  return url.toString();
}

function reconApi(stack, path, options = {}) {
  return fetch(`http://127.0.0.1:${stack.ports.reconciliation}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Tenant-Id": TENANT_1, ...(options.headers || {}) }
  });
}

async function waitForStatementLines(stack, statementId, { matched, exception }) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await reconApi(stack, "/statements");
    const statement = (await res.json()).find((s) => s.id === statementId);
    if (statement && statement.matchedCount === matched && statement.exceptionCount === exception) {
      return statement;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`statement ${statementId} did not reach matched=${matched} exception=${exception} in time`);
}

async function waitForPaymentStatus(stack, paymentId, status) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await api(stack.baseUrl, "/state");
    const payment = state.data.payments?.find((p) => p.id === paymentId);
    if (payment?.status === status) return payment;
    if (payment?.status === "Failed" || payment?.status === "Blocked") {
      throw new Error(`payment ${paymentId} ended ${payment.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`payment ${paymentId} did not reach ${status} in time`);
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

function signature(payload) {
  return createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(payload)).digest("hex");
}

function postWebhook(baseUrl, providerId, payload, webhookSignature) {
  return api(baseUrl, `/webhooks/${providerId}`, {
    method: "POST",
    headers: { "x-webhook-signature": webhookSignature },
    body: JSON.stringify(payload)
  });
}

test("webhook ingestion rejects invalid signatures without poisoning valid retries", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const payload = {
    eventId: "webhook-invalid-then-valid",
    eventType: "settlement_confirmed",
    paymentRef: "PMT-1001"
  };

  const invalid = await postWebhook(stack.baseUrl, "prov-arcadia", payload, "bad-signature");
  assert.equal(invalid.status, 401);
  assert.equal(invalid.data.error, "invalid_signature");

  const validRetry = await postWebhook(stack.baseUrl, "prov-arcadia", payload, signature(payload));
  assert.equal(validRetry.status, 200);
  assert.equal(validRetry.data.status, "processed");

  const duplicate = await postWebhook(stack.baseUrl, "prov-arcadia", payload, signature(payload));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.status, "duplicate");
});

test("webhook deduplication is scoped by provider and external id — different providers can share external id", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const sharedPayload = {
    eventId: "webhook-diff-providers-same-external-id",
    eventType: "settlement_confirmed",
    paymentRef: "PMT-1001"
  };

  // Different providers are different tenants — same external_id is allowed
  const prov1 = await postWebhook(stack.baseUrl, "prov-arcadia", sharedPayload, signature(sharedPayload));
  const prov2 = await postWebhook(stack.baseUrl, "prov-meridian", sharedPayload, signature(sharedPayload));
  // Duplicate to prov-arcadia should be deduped
  const dup = await postWebhook(stack.baseUrl, "prov-arcadia", sharedPayload, signature(sharedPayload));

  assert.equal(prov1.status, 200);
  assert.equal(prov1.data.status, "processed");
  assert.equal(prov2.status, 200);
  assert.equal(prov2.data.status, "processed");
  assert.equal(dup.status, 200);
  assert.equal(dup.data.status, "duplicate");
});

test("gateway docs include V3 repair, attempts, and webhook endpoints", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const docs = await api(stack.baseUrl, "/docs");
  assert.equal(docs.status, 200);
  assert.ok(docs.data.endpoints.includes("GET /api/repair"));
  assert.ok(docs.data.endpoints.includes("POST /api/repair/:id/retry"));
  assert.ok(docs.data.endpoints.includes("GET /api/payments/:id/attempts"));
  assert.ok(docs.data.endpoints.includes("POST /api/webhooks/:providerId"));
});

test("settled webhook triggers statement matching for the referenced payment", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // The provider ref does not exist yet when the statement is ingested, so the
  // match-statement job (enqueued at ingestion) leaves the line unmatched. The
  // settlement webhook is what closes the loop: it must re-run the matcher for any
  // statement that references the settled transfer.
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "webhook-f5-1" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;
  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });

  const providerRef = "ARC-WEBHOOK-F5";
  const ingest = await reconApi(stack, "/statements", {
    method: "POST",
    body: JSON.stringify({
      providerId: "prov-arcadia",
      externalId: "stmt-f5-webhook",
      lines: [{ providerRef, amount: 5000, asset: "EURC" }]
    })
  });
  const ingested = await ingest.json();
  assert.equal(ingested.status, "ingested");

  // The ingestion match job must run and leave the line unmatched before we proceed.
  await waitForStatementLines(stack, ingested.statementId, { matched: 0, exception: 1 });

  // The provider assigns the ref at submission time; the saga reuses a pre-set
  // provider_ref, so executing now gives the payment exactly the ref the webhook
  // will confirm later.
  const admin = new pg.Client({ connectionString: adminDbUrl(stack) });
  await admin.connect();
  await admin.query("UPDATE payment.payments SET provider_ref = $1 WHERE id = $2", [providerRef, paymentId]);
  await admin.end();

  await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  const settled = await waitForPaymentStatus(stack, paymentId, "Settled");
  assert.equal(settled.providerRef, providerRef, "payment must carry the ref the webhook confirms");

  const payload = { eventId: "f5-settled-1", eventType: "transfer.settled", paymentRef: providerRef };
  const delivered = await postWebhook(stack.baseUrl, "prov-arcadia", payload, signature(payload));
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.status, "processed");

  // The webhook must trigger matching: the statement line flips from unmatched to matched.
  const matched = await waitForStatementLines(stack, ingested.statementId, { matched: 1, exception: 0 });
  assert.equal(matched.matchedCount, 1);

  // Duplicate deliveries stay deduped and must not re-trigger matching.
  const dup = await postWebhook(stack.baseUrl, "prov-arcadia", payload, signature(payload));
  assert.equal(dup.status, 200);
  assert.equal(dup.data.status, "duplicate");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitForStatementLines(stack, ingested.statementId, { matched: 1, exception: 0 });

  // Exactly one matched line, and exactly one Matched row for the payment — the
  // saga's own confirm row, which the statement match must not duplicate.
  const finalClient = new pg.Client({ connectionString: adminDbUrl(stack) });
  await finalClient.connect();
  const { rows: lineRows } = await finalClient.query(
    "SELECT match_status FROM reconciliation.statement_lines WHERE statement_id = $1",
    [ingested.statementId]
  );
  const { rows: matchRows } = await finalClient.query(
    "SELECT COUNT(*)::int AS c FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = 'Matched'",
    [TENANT_1, paymentId]
  );
  await finalClient.end();
  assert.deepEqual(lineRows.map((r) => r.match_status), ["matched"]);
  assert.equal(matchRows[0].c, 1);
});
