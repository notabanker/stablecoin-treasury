import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedJournals(tenantId = DEFAULT_TENANT_ID) {
  const { journalEntries } = createSeedData(tenantId);
  await withTransaction("accounting", async (client) => {
    // Deletes run under owner privileges via SECURITY DEFINER function (migration 0055)
    await client.query("SELECT accounting.reset_seed($1)", [tenantId]);
    for (const entry of journalEntries) {
      await client.query(
        `INSERT INTO accounting.journal_entries (id, tenant_id, date, entity_id, payment_id, account, debit, credit, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [entry.id, tenantId, entry.date, entry.entityId, entry.paymentId, entry.account, entry.debit, entry.credit, entry.currency, entry.status]
      );
    }
  }, { tenantId });
}
