-- V6 Epic 2.2: row-level security, wallet schema. See 0037 for the pattern rationale.
--
-- wallet.ledger_entries deliberately has NO policy: it carries no tenant_id column.
-- Entries are only reachable through their parent ledger_transactions (RLS-scoped) or
-- the balanced-ledger trigger, and the append-only REVOKE already applies. Adding a
-- tenant column to a live append-only ledger table is a schema change out of scope here.

ALTER TABLE wallet.assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet.assets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wallet.ledger_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet.ledger_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wallet.ledger_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet.ledger_transactions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wallet.legal_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet.legal_entities
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- wallet.wallet_balances is a VIEW (ledger-derived read model), so it cannot carry RLS
-- itself. Without security_invoker a view executes with its OWNER's privileges, which
-- would silently BYPASS the RLS on the underlying tables for every querying role.
-- security_invoker = true makes the caller's own RLS context apply to wallets /
-- ledger_accounts underneath, tenant-scoping the derived balances.
ALTER VIEW wallet.wallet_balances SET (security_invoker = true);

ALTER TABLE wallet.wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet.wallets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
