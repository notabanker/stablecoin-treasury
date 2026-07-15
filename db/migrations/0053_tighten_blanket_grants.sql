-- Audit finding H5: Tighten blanket grants — revoke destructive DML on audit/log tables.
--
-- operations.audit_events must be append-only for all roles (already revoked from PUBLIC
-- in 0008, but svc_operations had blanket UPDATE/DELETE via the schema-level grant).
-- payment.payment_events and payment.payment_approvals are append-only audit/log tables.
-- Ledger/journal tables (wallet.*) must not allow DELETE from any service role.
--
-- Also adds identity.tenants SELECT for svc_job (audit finding H3: getActiveTenants()
-- queries identity.tenants for multi-tenant background jobs).

-- ── 1. operations.audit_events: revoke UPDATE and DELETE from every role that may have it ──
REVOKE UPDATE, DELETE ON operations.audit_events FROM svc_operations;

-- ── 2. payment.payment_events: append-only ──
REVOKE UPDATE, DELETE ON payment.payment_events FROM svc_payment;
REVOKE UPDATE, DELETE ON payment.payment_events FROM svc_job;

-- ── 3. payment.payment_approvals: append-only ──
REVOKE UPDATE, DELETE ON payment.payment_approvals FROM svc_payment;
REVOKE UPDATE, DELETE ON payment.payment_approvals FROM svc_job;

-- ── 4. Ledger/journal tables: no DELETE from service roles ──
REVOKE DELETE ON wallet.ledger_accounts FROM svc_wallet;
REVOKE DELETE ON wallet.ledger_transactions FROM svc_wallet;
REVOKE DELETE ON wallet.ledger_entries FROM svc_wallet;

-- ── 5. H3 support: allow svc_job to query identity.tenants for getActiveTenants() ──
GRANT USAGE ON SCHEMA identity TO svc_job;
GRANT SELECT ON identity.tenants TO svc_job;
