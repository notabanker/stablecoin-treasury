import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function getOrCreateWalletAccount(client, walletId, assetId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query(
    `INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
     VALUES ($1, $2, 'wallet', $3)
     ON CONFLICT (tenant_id, wallet_id, account_type, asset_id) DO UPDATE SET asset_id = EXCLUDED.asset_id
     RETURNING *`,
    [tenantId, walletId, assetId]
  );
  return rows[0];
}

// fees/settlement_clearing/opening_balance are tenant-wide pooled accounts per asset, not tied
// to one wallet -- see the partial unique index in 0010_ledger.sql.
export async function getOrCreateSharedAccount(client, accountType, assetId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query(
    `INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (tenant_id, account_type, asset_id) WHERE wallet_id IS NULL
     DO UPDATE SET asset_id = EXCLUDED.asset_id
     RETURNING *`,
    [tenantId, accountType, assetId]
  );
  return rows[0];
}

export async function getWalletBalance(client, walletId, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await client.query("SELECT balance FROM wallet.wallet_balances WHERE wallet_id = $1 AND tenant_id = $2", [
    walletId,
    tenantId
  ]);
  return rows[0] ? Number(rows[0].balance) : 0;
}

// Idempotent by (tenant_id, idempotency_key): a second call with the same key returns the
// already-posted transaction instead of posting again, mirroring the payment-service pattern but
// enforced by wallet.ledger_transactions' own unique constraint rather than a caller-managed map.
export async function postTransaction(client, { idempotencyKey, description, paymentId, entries, tenantId = DEFAULT_TENANT_ID }) {
  const inserted = await client.query(
    `INSERT INTO wallet.ledger_transactions (tenant_id, idempotency_key, description, payment_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [tenantId, idempotencyKey, description, paymentId || null]
  );
  if (inserted.rows.length === 0) {
    const { rows } = await client.query("SELECT * FROM wallet.ledger_transactions WHERE tenant_id = $1 AND idempotency_key = $2", [
      tenantId,
      idempotencyKey
    ]);
    return { transaction: rows[0], alreadyPosted: true };
  }
  const transaction = inserted.rows[0];
  for (const entry of entries) {
    await client.query("INSERT INTO wallet.ledger_entries (transaction_id, account_id, direction, amount) VALUES ($1, $2, $3, $4)", [
      transaction.id,
      entry.accountId,
      entry.direction,
      entry.amount
    ]);
  }
  return { transaction, alreadyPosted: false };
}
