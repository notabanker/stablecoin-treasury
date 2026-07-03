import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedWallets() {
  const { entities, assets, wallets } = createSeedData();
  await withTransaction("wallet", async (client) => {
    // Order matters: wallets FKs to legal_entities and assets, debit_operations FKs to wallets.
    await client.query("DELETE FROM wallet.debit_operations WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM wallet.wallets WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM wallet.assets WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM wallet.legal_entities WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);

    for (const entity of entities) {
      await client.query(
        `INSERT INTO wallet.legal_entities (id, tenant_id, name, jurisdiction, base_currency, erp_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entity.id, DEFAULT_TENANT_ID, entity.name, entity.jurisdiction, entity.baseCurrency, entity.erpCode]
      );
    }
    for (const asset of assets) {
      await client.query(
        `INSERT INTO wallet.assets (id, tenant_id, name, currency, issuer, chain, classification, status, risk, provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [asset.id, DEFAULT_TENANT_ID, asset.name, asset.currency, asset.issuer, asset.chain, asset.classification, asset.status, asset.risk, asset.providerId]
      );
    }
    for (const wallet of wallets) {
      await client.query(
        `INSERT INTO wallet.wallets (id, tenant_id, entity_id, provider_id, asset_id, address, custody, status, balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [wallet.id, DEFAULT_TENANT_ID, wallet.entityId, wallet.providerId, wallet.asset, wallet.address, wallet.custody, wallet.status, wallet.balance]
      );
    }
  });
}
