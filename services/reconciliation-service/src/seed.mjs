import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedReconciliation() {
  const { reconciliation } = createSeedData();
  await withTransaction("reconciliation", async (client) => {
    await client.query("DELETE FROM reconciliation.reconciliation_rows WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    for (const row of reconciliation) {
      await client.query(
        `INSERT INTO reconciliation.reconciliation_rows (id, tenant_id, payment_id, source, issue, amount, asset, status, owner, created_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.id,
          DEFAULT_TENANT_ID,
          row.paymentId,
          row.source,
          row.issue,
          row.amount,
          row.asset,
          row.status,
          row.owner,
          row.createdAt,
          row.resolvedAt || null
        ]
      );
    }
  });
}
