import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedReconciliation(tenantId = DEFAULT_TENANT_ID) {
  const { reconciliation } = createSeedData(tenantId);
  await withTransaction("reconciliation", async (client) => {
    // FK order: statement lines reference statements; both go before the rows wipe so a
    // demo reset never trips a foreign key (V6 lesson — see docs/V6_REMAINING_TASKS_INSTRUCTION.md).
    await client.query("DELETE FROM reconciliation.statement_lines WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM reconciliation.provider_statements WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM reconciliation.reconciliation_rows WHERE tenant_id = $1", [tenantId]);
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
