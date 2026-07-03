-- Append-only double-entry ledger. Wallet balances stop being a directly-mutable column and
-- become a derived read model (wallet.wallet_balances, below) over immutable entries. This is
-- the M2 "money cannot disappear" foundation: every balance movement is now two or more entries
-- that must sum to zero across debits and credits for a transaction, enforced at COMMIT by a
-- deferred trigger, not just by application code remembering to keep both sides in sync.
--
-- Sign convention (this is a treasury ledger, not a formal GL with debit-normal asset accounts):
-- a debit to a 'wallet' account DECREASES its balance (money leaving); a credit INCREASES it.
-- wallet balance = SUM(credits) - SUM(debits) on that wallet's own ledger account.

CREATE TABLE wallet.ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  wallet_id TEXT REFERENCES wallet.wallets (id),
  account_type TEXT NOT NULL CHECK (account_type IN ('wallet', 'fees', 'settlement_clearing', 'opening_balance')),
  asset_id TEXT NOT NULL REFERENCES wallet.assets (id),
  CHECK ((account_type = 'wallet') = (wallet_id IS NOT NULL)),
  UNIQUE (tenant_id, wallet_id, account_type, asset_id)
);

-- fees/settlement_clearing/opening_balance are tenant-wide pooled accounts per asset (wallet_id
-- IS NULL); the table UNIQUE constraint above doesn't dedupe NULLs, so a partial index covers
-- that case separately.
CREATE UNIQUE INDEX ledger_accounts_shared_uniq ON wallet.ledger_accounts (tenant_id, account_type, asset_id) WHERE wallet_id IS NULL;

-- Append-only: an idempotency_key identifies one logical posting (e.g. "debit:<paymentId>"), so
-- retrying the same logical operation is detected here before any entries are written, the same
-- pattern as payment.idempotency_keys but scoped to money movement specifically.
CREATE TABLE wallet.ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  idempotency_key TEXT NOT NULL,
  description TEXT NOT NULL,
  payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

REVOKE UPDATE, DELETE ON wallet.ledger_transactions FROM PUBLIC;

CREATE TABLE wallet.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES wallet.ledger_transactions (id),
  account_id UUID NOT NULL REFERENCES wallet.ledger_accounts (id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE UPDATE, DELETE ON wallet.ledger_entries FROM PUBLIC;

CREATE INDEX ledger_entries_transaction_idx ON wallet.ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON wallet.ledger_entries (account_id);

-- Every transaction posted here is single-asset today (no FX conversion within one payment), so
-- balance is checked per transaction, not per transaction-per-asset. A future FX transaction type
-- would need this trigger to group by asset_id via ledger_accounts.
CREATE OR REPLACE FUNCTION wallet.assert_ledger_transaction_balanced() RETURNS TRIGGER AS $$
DECLARE
  imbalance NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
  INTO imbalance
  FROM wallet.ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced by %', NEW.transaction_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced_trigger
  AFTER INSERT ON wallet.ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION wallet.assert_ledger_transaction_balanced();

CREATE VIEW wallet.wallet_balances AS
SELECT
  w.id AS wallet_id,
  w.tenant_id,
  COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE 0 END), 0) AS balance
FROM wallet.wallets w
LEFT JOIN wallet.ledger_accounts la ON la.wallet_id = w.id AND la.account_type = 'wallet'
LEFT JOIN wallet.ledger_entries le ON le.account_id = la.id
GROUP BY w.id, w.tenant_id;

-- The balance column is superseded by the view above; keeping both would let them drift.
-- Existing balances are migrated into opening-balance ledger transactions by the application
-- seed step (services/wallet-service/src/seed.mjs), not here, so the seed data stays the single
-- source of truth for demo balances instead of being duplicated into a migration file.
ALTER TABLE wallet.wallets DROP COLUMN balance;
