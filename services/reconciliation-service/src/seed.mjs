import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedReconciliation(tenantId = DEFAULT_TENANT_ID) {
  const { reconciliation } = createSeedData(tenantId);
  await withTransaction("reconciliation", async (client) => {
    // Deletes run under owner privileges via SECURITY DEFINER function (migration 0055)
    await client.query("SELECT reconciliation.reset_seed($1)", [tenantId]);
    for (const row of reconciliation) {
      await client.query(
        `INSERT INTO reconciliation.reconciliation_rows (id, tenant_id, payment_id, source, issue, amount, asset, status, owner, created_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.id,
          tenantId,
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
  }, { tenantId });
}
