import { query, withTransaction } from "./db.mjs";

// Tamper-evident audit hash chain (V6 Epic 3, migration 0032).
//
// Every operations.audit_events row commits to its predecessor: per tenant, rows carry a
// monotonically increasing chain_seq, the previous row's hash (prev_hash), and their own
// row_hash. All hashing happens in SQL so there is exactly ONE canonical serialization —
// no JS/SQL formatting drift can break the chain.
//
// Canonical material (sha256 over UTF-8 bytes):
//   concat_ws(0x1F, tenant_id::text, id, actor, action, object, detail,
//             to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), prev_hash)
// 0x1F (ASCII unit separator) avoids field-boundary ambiguity. Every field is NOT NULL in
// the schema, so concat_ws never silently drops a field. Genesis rows use prev_hash = ''.
//
// Appends serialize per tenant via pg_advisory_xact_lock(hashtext(tenant_id::text)) inside
// the caller's transaction; the lock releases on commit/rollback.

const CANONICAL_HASH_SQL = (tenantExpr, idExpr, actorExpr, actionExpr, objectExpr, detailExpr, atExpr, prevExpr) =>
  `encode(digest(convert_to(concat_ws(E'\\x1f',
     ${tenantExpr}, ${idExpr}, ${actorExpr}, ${actionExpr}, ${objectExpr}, ${detailExpr},
     to_char(${atExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
     ${prevExpr}), 'UTF8'), 'sha256'), 'hex')`;

// Note: in INSERT ... SELECT, Postgres does not infer bare $n types from the target
// columns (unlike INSERT ... VALUES), so every parameter carries an explicit cast.
const CHAINED_INSERT_SQL = `
  WITH head AS (
    SELECT chain_seq, row_hash
      FROM operations.audit_events
     WHERE tenant_id = $2::uuid
     ORDER BY chain_seq DESC
     LIMIT 1
  )
  INSERT INTO operations.audit_events
    (id, tenant_id, actor, action, object, detail, at, chain_seq, prev_hash, row_hash)
  SELECT $1::text, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::timestamptz,
         COALESCE(h.chain_seq, 0) + 1,
         COALESCE(h.row_hash, ''),
         ${CANONICAL_HASH_SQL("$2::text", "$1::text", "$3::text", "$4::text", "$5::text", "$6::text", "$7::timestamptz", "COALESCE(h.row_hash, '')")}
    FROM (SELECT 1) AS one
    LEFT JOIN head h ON true
  RETURNING chain_seq, row_hash`;

// Insert one chain-linked audit event using the caller's transaction client. The advisory
// lock serializes concurrent appends for the same tenant; it is transaction-scoped, so the
// caller MUST be inside a transaction (BEGIN..COMMIT) for the lock to do its job.
export async function insertAuditEventChained(client, { id, tenantId, actor, action, object, detail, at }) {
  // RLS: the audit event's tenant can differ from the request context (e.g. a tenant-2
  // failed-login audit written during a request that carries no tenant header), so the
  // transaction-local tenant is set explicitly to the event's tenant.
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [tenantId]);
  const { rows } = await client.query(CHAINED_INSERT_SQL, [
    String(id),
    tenantId,
    String(actor ?? "System"),
    String(action ?? ""),
    String(object ?? ""),
    String(detail ?? ""),
    at instanceof Date ? at.toISOString() : String(at)
  ]);
  return rows[0];
}

// Convenience wrapper for callers without an open transaction.
export async function insertAuditEvent(poolName, event) {
  return withTransaction(poolName, (client) => insertAuditEventChained(client, event));
}

const VERIFY_SQL = `
  WITH ordered AS (
    SELECT id, tenant_id, chain_seq, prev_hash, row_hash,
           LAG(row_hash) OVER w AS expected_prev,
           LAG(chain_seq) OVER w AS prev_seq,
           ${CANONICAL_HASH_SQL("tenant_id::text", "id", "actor", "action", "object", "detail", "at", "prev_hash")} AS recomputed
      FROM operations.audit_events
    WINDOW w AS (PARTITION BY tenant_id ORDER BY chain_seq)
  )
  SELECT id, tenant_id, chain_seq,
         CASE
           WHEN row_hash <> recomputed THEN 'row_hash_mismatch'
           WHEN prev_seq IS NULL AND chain_seq <> 1 THEN 'missing_genesis'
           WHEN prev_seq IS NOT NULL AND chain_seq <> prev_seq + 1 THEN 'sequence_gap'
           WHEN prev_hash <> COALESCE(expected_prev, '') THEN 'prev_hash_mismatch'
         END AS reason
    FROM ordered
   WHERE row_hash <> recomputed
      OR prev_hash <> COALESCE(expected_prev, '')
      OR (prev_seq IS NULL AND chain_seq <> 1)
      OR (prev_seq IS NOT NULL AND chain_seq <> prev_seq + 1)
   ORDER BY tenant_id, chain_seq
   LIMIT 1`;

// Walk every tenant chain and recompute every hash. Returns
//   { ok: true, checkedRows }                        when every chain is intact
//   { ok: false, checkedRows, break: { id, tenantId, chainSeq, reason } }  on the first break
// Detects: field tampering (row_hash_mismatch), relinking (prev_hash_mismatch), interior
// deletions (sequence_gap), and deleted genesis (missing_genesis). NOT detectable: deleting
// the newest rows of a tenant's chain (truncation) — that needs external anchoring/WORM
// offload (backlog 6.5); documented in docs/RUNBOOKS.md.
export async function verifyAuditChain(clientOrPoolName) {
  const run = typeof clientOrPoolName === "string"
    ? (text, params) => query(clientOrPoolName, text, params)
    : (text, params) => clientOrPoolName.query(text, params);
  const { rows: countRows } = await run("SELECT COUNT(*)::int AS count FROM operations.audit_events");
  const { rows } = await run(VERIFY_SQL);
  if (!rows[0]) {
    return { ok: true, checkedRows: countRows[0].count };
  }
  return {
    ok: false,
    checkedRows: countRows[0].count,
    break: {
      id: rows[0].id,
      tenantId: rows[0].tenant_id,
      chainSeq: Number(rows[0].chain_seq),
      reason: rows[0].reason
    }
  };
}
