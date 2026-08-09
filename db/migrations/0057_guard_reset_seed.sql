-- Guard the SECURITY DEFINER reset functions (0055) against cross-tenant use.
--
-- 0055 took a caller-supplied p_tenant_id with no check against the session's
-- RLS tenant context (current_setting('app.tenant_id')), letting any role with
-- EXECUTE delete another tenant's append-only rows (audit_events,
-- payment_events, payment_approvals, ledger). Every function now fails closed
-- when the context is missing or differs.
--
-- GRANT EXECUTE lines are unchanged (CREATE OR REPLACE keeps existing grants,
-- so they are NOT re-run here).

-- ── 1. wallet.reset_seed(p_tenant_id) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION wallet.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
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

-- ── 2. payment.reset_seed(p_tenant_id) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION payment.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM payment.idempotency_keys WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_events WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_approvals WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payments WHERE tenant_id = p_tenant_id;
END;
$$;

-- ── 3. operations.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION operations.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM operations.providers WHERE tenant_id = p_tenant_id;
  DELETE FROM operations.alerts WHERE tenant_id = p_tenant_id;
  DELETE FROM operations.audit_events WHERE tenant_id = p_tenant_id;
END;
$$;

-- ── 4. accounting.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION accounting.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM accounting.journal_entries WHERE tenant_id = p_tenant_id;
END;
$$;

-- ── 5. policy.reset_seed(p_tenant_id) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION policy.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM policy.policies WHERE tenant_id = p_tenant_id;
END;
$$;

-- ── 6. compliance.reset_seed(p_tenant_id) ──────────────────────────────────
CREATE OR REPLACE FUNCTION compliance.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM compliance.counterparties WHERE tenant_id = p_tenant_id;
END;
$$;

-- ── 7. reconciliation.reset_seed(p_tenant_id) ──────────────────────────────
CREATE OR REPLACE FUNCTION reconciliation.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM reconciliation.statement_lines WHERE tenant_id = p_tenant_id;
  DELETE FROM reconciliation.provider_statements WHERE tenant_id = p_tenant_id;
  DELETE FROM reconciliation.reconciliation_rows WHERE tenant_id = p_tenant_id;
END;
$$;
