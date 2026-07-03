import { createHmac, timingSafeEqual } from "node:crypto";
import { query } from "../../../packages/shared/db.mjs";
import { enqueueJob } from "../../../packages/shared/jobs.mjs";
import { httpError } from "../../../packages/shared/http.mjs";

const DB = "platform";
const OPS = "operations";

export function verifySignature(payload, secret, signature) {
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(String(signature || ""), "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

// Resolve the provider record from the DB. Returns { id, tenant_id, webhook_secret } or null.
async function resolveProvider(providerId) {
  const { rows } = await query(
    OPS,
    `SELECT id, tenant_id, webhook_secret
     FROM operations.providers
     WHERE id = $1
     LIMIT 1`,
    [providerId]
  );
  return rows[0] || null;
}

// In sandbox/demo mode, allow providers that don't have a configured webhook_secret to
// accept webhooks signed with the default demo secret. In production (PRODUCTION_MODE=true),
// every provider must have a configured webhook_secret.
const PRODUCTION_MODE = process.env.PRODUCTION_MODE === "true";
const DEMO_WEBHOOK_SECRET = process.env.DEMO_WEBHOOK_SECRET || "sandbox-webhook-secret";

export async function processWebhook(providerId, body, signature) {
  const eventId = body.eventId || body.id;
  if (!eventId) {
    throw httpError(422, "Missing eventId in webhook payload", "missing_event_id");
  }

  // Resolve provider identity. Tenant comes from the provider record, never from the payload.
  const provider = await resolveProvider(providerId);
  if (!provider) {
    throw httpError(401, "Unknown webhook provider", "unknown_provider");
  }

  // Determine signing secret: per-provider config takes precedence, then demo fallback.
  let secret;
  if (provider.webhook_secret) {
    secret = provider.webhook_secret;
  } else if (!PRODUCTION_MODE) {
    secret = DEMO_WEBHOOK_SECRET;
  } else {
    throw httpError(401, "Provider has no configured webhook secret", "missing_provider_secret");
  }

  const signatureValid = verifySignature(body, secret, signature);
  if (!signatureValid) {
    throw httpError(401, "Invalid webhook signature", "invalid_signature");
  }

  // Tenant is derived from the provider configuration, never from the request body.
  const tenantId = provider.tenant_id;

  // Deduplicate by (provider_id, tenant_id, external_id)
  try {
    await query(
      DB,
      `INSERT INTO platform.webhook_events (provider_id, tenant_id, external_id, event_type, signature_valid, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        providerId,
        tenantId,
        eventId,
        body.eventType || body.type || "unknown",
        signatureValid,
        JSON.stringify(body)
      ]
    );
  } catch (error) {
    if (error.code === "23505") {
      return { status: "duplicate", message: "Webhook already processed" };
    }
    throw error;
  }

  const eventType = body.eventType || body.type;
  if (eventType === "transfer.settled" || eventType === "settlement_confirmed") {
    await enqueueJob("process-settlement-webhook", {
      providerId,
      eventId,
      tenantId,
      paymentRef: body.paymentRef || body.providerRef
    }, { maxAttempts: 3, tenantId });
  }

  return { status: "processed", eventId };
}
