import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { getOrCreateSharedAccount, getOrCreateWalletAccount, postTransaction } from "./ledger.mjs";

export async function reseedWallets() {
  const { entities, assets, wallets } = createSeedData();
  await withTransaction("wallet", async (client) => {
    // Order matters: wallets FKs to legal_entities and assets; ledger_accounts FKs to wallets;
    // ledger_entries FKs to ledger_accounts and ledger_transactions.
    await client.query(
      `DELETE FROM wallet.ledger_entries le
       WHERE EXISTS (
         SELECT 1 FROM wallet.ledger_transactions lt
         WHERE lt.id = le.transaction_id AND lt.tenant_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM wallet.ledger_accounts la
         WHERE la.id = le.account_id AND la.tenant_id = $1
       )`,
      [DEFAULT_TENANT_ID]
    );
    await client.query("DELETE FROM wallet.ledger_transactions WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM wallet.ledger_accounts WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
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
        `INSERT INTO wallet.wallets (id, tenant_id, entity_id, provider_id, asset_id, address, custody, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [wallet.id, DEFAULT_TENANT_ID, wallet.entityId, wallet.providerId, wallet.asset, wallet.address, wallet.custody, wallet.status]
      );
    }

    // Seed balances are opening-balance ledger transactions, not a column write: even demo data
    // goes through the same double-entry posting path production balances will use, crediting
    // each wallet from a shared opening_balance contra account per asset.
    for (const wallet of wallets) {
      if (!wallet.balance) continue;
      const walletAccount = await getOrCreateWalletAccount(client, wallet.id, wallet.asset);
      const openingAccount = await getOrCreateSharedAccount(client, "opening_balance", wallet.asset);
      await postTransaction(client, {
        idempotencyKey: `seed-opening-balance:${wallet.id}`,
        description: `Seed opening balance for ${wallet.id}`,
        entries: [
          { accountId: openingAccount.id, direction: "debit", amount: wallet.balance },
          { accountId: walletAccount.id, direction: "credit", amount: wallet.balance }
        ]
      });
    }
  }, { tenantId: DEFAULT_TENANT_ID });
}
