-- Repair tenant 2 opening-balance ledger entries if an older wallet reset deleted entries
-- without deleting the corresponding tenant-scoped ledger transactions.

DO $$
DECLARE
  tenant UUID := '00000000-0000-0000-0000-000000000002';
  opening RECORD;
  wallet_account UUID;
  opening_account UUID;
  tx_id UUID;
  entry_count INT;
BEGIN
  FOR opening IN
    SELECT *
    FROM (VALUES
      ('wal-nordic-eur'::TEXT, 'N-EURC'::TEXT, 520000::NUMERIC),
      ('wal-nordic-usd'::TEXT, 'N-USDC'::TEXT, 180000::NUMERIC)
    ) AS values(wallet_id, asset_id, amount)
  LOOP
    INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
    VALUES (tenant, opening.wallet_id, 'wallet', opening.asset_id)
    ON CONFLICT (tenant_id, wallet_id, account_type, asset_id) DO UPDATE SET asset_id = EXCLUDED.asset_id
    RETURNING id INTO wallet_account;

    INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
    VALUES (tenant, NULL, 'opening_balance', opening.asset_id)
    ON CONFLICT (tenant_id, account_type, asset_id) WHERE wallet_id IS NULL DO UPDATE SET asset_id = EXCLUDED.asset_id
    RETURNING id INTO opening_account;

    tx_id := NULL;
    INSERT INTO wallet.ledger_transactions (tenant_id, idempotency_key, description, payment_id)
    VALUES (tenant, 'seed-opening-balance:' || opening.wallet_id, 'Seed opening balance for ' || opening.wallet_id, NULL)
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id INTO tx_id;

    IF tx_id IS NULL THEN
      SELECT id INTO tx_id
      FROM wallet.ledger_transactions
      WHERE tenant_id = tenant AND idempotency_key = 'seed-opening-balance:' || opening.wallet_id;
    END IF;

    SELECT COUNT(*) INTO entry_count
    FROM wallet.ledger_entries
    WHERE transaction_id = tx_id;

    IF entry_count = 0 THEN
      INSERT INTO wallet.ledger_entries (transaction_id, account_id, direction, amount)
      VALUES
        (tx_id, opening_account, 'debit', opening.amount),
        (tx_id, wallet_account, 'credit', opening.amount);
    ELSIF entry_count <> 2 THEN
      RAISE EXCEPTION 'Opening balance transaction % for % has % entries; manual repair required',
        tx_id, opening.wallet_id, entry_count;
    END IF;
  END LOOP;
END $$;
