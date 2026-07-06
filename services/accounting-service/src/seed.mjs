import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedJournals() {
  const { journalEntries } = createSeedData();
  await withTransaction("accounting", async (client) => {
    await client.query("DELETE FROM accounting.journal_entries WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    for (const entry of journalEntries) {
      await client.query(
        `INSERT INTO accounting.journal_entries (id, tenant_id, date, entity_id, payment_id, account, debit, credit, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [entry.id, DEFAULT_TENANT_ID, entry.date, entry.entityId, entry.paymentId, entry.account, entry.debit, entry.credit, entry.currency, entry.status]
      );
    }
  }, { tenantId: DEFAULT_TENANT_ID });
}
