import { createHash } from "node:crypto";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

const DB = "payment";

export function hashRequest(input) {
  const canonical = JSON.stringify(sortKeys(input ?? {}));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Reserve via INSERT ... ON CONFLICT DO NOTHING against the (tenant, key, action) primary key.
// Under Postgres's default READ COMMITTED isolation, a second call racing on the same key
// blocks on this INSERT until the first transaction commits or rolls back -- so by the time this
// function's conflict branch runs, the other attempt's outcome is already durable. There is no
// "in progress" state visible to a caller the way there was with the M0 in-process JS lock: the
// database serializes the two attempts for us.
export async function reserveIdempotencyKey(action, idempotencyKey, requestHash) {
  return withTransaction(DB, async (client) => {
    const inserted = await client.query(
      `INSERT INTO payment.idempotency_keys (tenant_id, idempotency_key, action, request_hash, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (tenant_id, idempotency_key, action) DO NOTHING
       RETURNING *`,
      [DEFAULT_TENANT_ID, idempotencyKey, action, requestHash]
    );
    if (inserted.rows.length > 0) {
      return { outcome: "reserved" };
    }
    const { rows } = await client.query(
      "SELECT * FROM payment.idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2 AND action = $3",
      [DEFAULT_TENANT_ID, idempotencyKey, action]
    );
    const existing = rows[0];
    if (existing.request_hash !== requestHash) {
      return { outcome: "hash_mismatch" };
    }
    return { outcome: "done", paymentId: existing.payment_id };
  });
}

export async function completeIdempotencyKey(action, idempotencyKey, paymentId) {
  if (!idempotencyKey) return;
  await query(
    DB,
    "UPDATE payment.idempotency_keys SET status = 'done', payment_id = $1 WHERE tenant_id = $2 AND idempotency_key = $3 AND action = $4",
    [paymentId, DEFAULT_TENANT_ID, idempotencyKey, action]
  );
}

export async function releaseIdempotencyKey(action, idempotencyKey) {
  if (!idempotencyKey) return;
  await query(DB, "DELETE FROM payment.idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2 AND action = $3", [
    DEFAULT_TENANT_ID,
    idempotencyKey,
    action
  ]);
}

export async function allocateReference() {
  const { rows } = await query(DB, "SELECT nextval('payment.payment_reference_seq') AS n");
  return `PMT-${rows[0].n}`;
}
