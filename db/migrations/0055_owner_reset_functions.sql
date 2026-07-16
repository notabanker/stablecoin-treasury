-- Epic 2.2: SECURITY DEFINER reset functions for append-only tables.
--
-- Migration 0053 correctly revoked DELETE on append-only audit/log tables
-- (audit_events, payment_events, payment_approvals, ledger tables). But the
-- service seed/reset paths still performed DELETE under their low-privilege
-- service roles, causing 42501 permission denied at boot.
--
-- This migration creates SECURITY DEFINER functions (owned by the migration
-- owner, running with the owner's privileges) that perform the DELETE for
-- each schema. Seed files call these functions instead of doing direct DELETE.
--
-- Also includes:
--   - Fix M8: GRANT SELECT ON operations.providers TO svc_reconciliation
--   - Fix M6: Replace unsalted SHA-256 password hash for Maria with scrypt

-- ── 1. wallet.reset_seed(p_tenant_id) ──────────────────────────────────────
-- Deletes all seed data for the given tenant from wallet tables.
-- Order respects FK constraints: ledger_entries first, then ledger_transactions
-- and ledger_accounts, then wallets/assets/legal_entities.
CREATE OR REPLACE FUNCTION wallet.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  -- ledger_entries has FKs to both ledger_transactions and ledger_accounts
  DELETE FROM wallet.ledger_entries le
  WHERE EXISTS (
    SELECT 1 FROM wallet.ledger_transactions lt
    WHERE lt.id = le.transaction_id AND lt.tenant_id = p_tenant_id
  )
  OR EXISTS (
    SELECT 1 FROM wallet.ledger_accounts la
    WHERE la.id = le.account_id AND la.tenant_id = p_tenant_id
  );
  DELETE FROM wallet.ledger_transactions WHERE tenant_id = p_tenant_id;
  DELETE FROM wallet.ledger_accounts WHERE tenant_id = p_tenant_id;
  DELETE FROM wallet.wallets WHERE tenant_id = p_tenant_id;
  DELETE FROM wallet.assets WHERE tenant_id = p_tenant_id;
  DELETE FROM wallet.legal_entities WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION wallet.reset_seed(UUID) TO svc_wallet;

-- ── 2. payment.reset_seed(p_tenant_id) ─────────────────────────────────────
-- Deletes all seed data for the given tenant from payment tables.
-- Order respects FK: approvals and events reference payments.
CREATE OR REPLACE FUNCTION payment.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM payment.idempotency_keys WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_events WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_approvals WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payments WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION payment.reset_seed(UUID) TO svc_payment;

-- ── 3. operations.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION operations.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM operations.providers WHERE tenant_id = p_tenant_id;
  DELETE FROM operations.alerts WHERE tenant_id = p_tenant_id;
  DELETE FROM operations.audit_events WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION operations.reset_seed(UUID) TO svc_operations;

-- ── 4. accounting.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION accounting.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM accounting.journal_entries WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION accounting.reset_seed(UUID) TO svc_accounting;

-- ── 5. policy.reset_seed(p_tenant_id) ──────────────────────────────────────
-- Policy uses INSERT ... ON CONFLICT DO UPDATE for seed data, so no DELETE
-- is needed during normal reseeding. This function exists for API consistency
-- and for explicit reset scenarios where the row should be removed.
CREATE OR REPLACE FUNCTION policy.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM policy.policies WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION policy.reset_seed(UUID) TO svc_policy;

-- ── 6. compliance.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION compliance.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM compliance.counterparties WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION compliance.reset_seed(UUID) TO svc_compliance;

-- ── 7. reconciliation.reset_seed(p_tenant_id) ──────────────────────────────
-- FK order: statement_lines reference provider_statements, so they go first.
CREATE OR REPLACE FUNCTION reconciliation.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM reconciliation.statement_lines WHERE tenant_id = p_tenant_id;
  DELETE FROM reconciliation.provider_statements WHERE tenant_id = p_tenant_id;
  DELETE FROM reconciliation.reconciliation_rows WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION reconciliation.reset_seed(UUID) TO svc_reconciliation;

-- ── 8. Fix M8: svc_reconciliation needs SELECT on operations.providers ────
-- The reconciliation service reads provider details when matching statements
-- against known providers. The svc_reconciliation role was never granted
-- SELECT on operations.providers.
GRANT USAGE ON SCHEMA operations TO svc_reconciliation;
GRANT SELECT ON operations.providers TO svc_reconciliation;

-- ── 9. Fix M6: Replace unsalted SHA-256 password hash with scrypt ─────────
-- Migration 0054 added Maria Schmidt with an unsalted SHA-256 hash resembling
-- the 0025 pattern but without actual scrypt. Replace it with a proper salted
-- scrypt hash matching the 0025 pattern used for all other seed users.
UPDATE identity.users
SET password_hash = 'scrypt$16384$8$1$zNm7P6Yk6prNuOfwYHTfmw$rQgLozr5CeiVLp7tuqe4DzMF7daU5zD83NtKI0Fp66jCjd3XvYdr8v6DJ__3hnWwDB53-5zMd677VPwjbUPLUw'
WHERE id = 'b0000000-0000-0000-0000-000000000002'
  AND tenant_id = '00000000-0000-0000-0000-000000000002';
