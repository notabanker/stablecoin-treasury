import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { getOrCreateSharedAccount, getOrCreateWalletAccount, postTransaction } from "./ledger.mjs";

export async function reseedWallets(tenantId = DEFAULT_TENANT_ID) {
  const { entities, assets, wallets } = createSeedData(tenantId);
  await withTransaction("wallet", async (client) => {
    // Deletes run under owner privileges via SECURITY DEFINER function (migration 0055)
    await client.query("SELECT wallet.reset_seed($1)", [tenantId]);

    for (const entity of entities) {
      await client.query(
        `INSERT INTO wallet.legal_entities (id, tenant_id, name, jurisdiction, base_currency, erp_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entity.id, tenantId, entity.name, entity.jurisdiction, entity.baseCurrency, entity.erpCode]
      );
    }
    for (const asset of assets) {
      await client.query(
        `INSERT INTO wallet.assets (id, tenant_id, name, currency, issuer, chain, classification, status, risk, provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [asset.id, tenantId, asset.name, asset.currency, asset.issuer, asset.chain, asset.classification, asset.status, asset.risk, asset.providerId]
      );
    }
    for (const wallet of wallets) {
      await client.query(
        `INSERT INTO wallet.wallets (id, tenant_id, entity_id, provider_id, asset_id, address, custody, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [wallet.id, tenantId, wallet.entityId, wallet.providerId, wallet.asset, wallet.address, wallet.custody, wallet.status]
      );
    }

    // Seed balances are opening-balance ledger transactions, not a column write: even demo data
    // goes through the same double-entry posting path production balances will use, crediting
    // each wallet from a shared opening_balance contra account per asset.
    for (const wallet of wallets) {
      if (!wallet.balance) continue;
      const walletAccount = await getOrCreateWalletAccount(client, wallet.id, wallet.asset, tenantId);
      const openingAccount = await getOrCreateSharedAccount(client, "opening_balance", wallet.asset, tenantId);
      await postTransaction(client, {
        idempotencyKey: `seed-opening-balance:${wallet.id}`,
        description: `Seed opening balance for ${wallet.id}`,
        entries: [
          { accountId: openingAccount.id, direction: "debit", amount: wallet.balance },
          { accountId: walletAccount.id, direction: "credit", amount: wallet.balance }
        ],
        tenantId
      });
    }
  }, { tenantId });
}
