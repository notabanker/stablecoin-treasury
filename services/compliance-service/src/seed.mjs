import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedCounterparties(tenantId = DEFAULT_TENANT_ID) {
  const { counterparties } = createSeedData(tenantId);
  await withTransaction("compliance", async (client) => {
    await client.query("DELETE FROM compliance.counterparties WHERE tenant_id = $1", [tenantId]);
    for (const counterparty of counterparties) {
      await client.query(
        `INSERT INTO compliance.counterparties (id, tenant_id, name, type, jurisdiction, status, risk, asset, wallet_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          counterparty.id,
          tenantId,
          counterparty.name,
          counterparty.type,
          counterparty.jurisdiction,
          counterparty.status,
          counterparty.risk,
          counterparty.asset,
          counterparty.wallet
        ]
      );
    }
  }, { tenantId });
}
