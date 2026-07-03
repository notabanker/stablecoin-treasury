import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "sandbox-webhook-secret";

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
