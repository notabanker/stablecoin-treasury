import { query } from "../../../packages/shared/db.mjs";
import { moneyNumber } from "../../../packages/shared/money.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

const DB = "reconciliation";

// Insert a reconciliation row on an existing transaction client when one is given
// (inbox-dedup and matching paths), otherwise as its own statement.
export async function insertRow(row, tenantId = DEFAULT_TENANT_ID, client = null) {
  const run = client || { query: (...args) => query(DB, ...args) };
  const { rows } = await run.query(
    `INSERT INTO reconciliation.reconciliation_rows (id, tenant_id, payment_id, source, issue, amount, asset, status, owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [row.id, tenantId, row.paymentId, row.source, row.issue, row.amount, row.asset, row.status, row.owner]
  );
  return rows[0];
}

export function withComputedAge(row) {
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const endedAt = row.resolved_at ? new Date(row.resolved_at) : new Date();
  const ageHours = Math.max(0, (endedAt.getTime() - createdAt.getTime()) / 3_600_000);
  return {
    id: row.id,
    paymentId: row.payment_id,
    source: row.source,
    issue: row.issue,
    amount: moneyNumber(row.amount),
    asset: row.asset,
    status: row.status,
    owner: row.owner,
    createdAt: createdAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10
  };
}

export async function listReconciliation(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 ORDER BY created_at DESC", [
    tenantId
  ]);
  return rows.map(withComputedAge);
}

export async function findMatchedRow(tenantId, paymentId, client = null) {
  const run = client || { query: (...args) => query(DB, ...args) };
  const { rows } = await run.query(
    "SELECT * FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = 'Matched'",
    [tenantId, paymentId]
  );
  return rows[0] || null;
}
