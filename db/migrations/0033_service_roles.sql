-- Epic 2.1: Per-service Postgres roles for defense-in-depth schema isolation.
-- Roles are CLUSTER-wide (use IF NOT EXISTS so parallel test databases share them safely).
-- Grants are per-database so every fresh test migration applies them.

DO $$
DECLARE
  svc_password TEXT := COALESCE(current_setting('app.svc_db_password', true), 'service-dev-password');
BEGIN
  -- svc_gateway: identity.*, operations.audit_events (INSERT+SELECT for chain head lookup),
  -- operations.providers (SELECT for webhook resolve), platform.webhook_events, platform.jobs.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_gateway') THEN
    EXECUTE format('CREATE ROLE svc_gateway LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_wallet: wallet.* + platform.outbox_events + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_wallet') THEN
    EXECUTE format('CREATE ROLE svc_wallet LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_policy: policy.* + platform.outbox_events + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_policy') THEN
    EXECUTE format('CREATE ROLE svc_policy LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_compliance: compliance.* + platform.outbox_events + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_compliance') THEN
    EXECUTE format('CREATE ROLE svc_compliance LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_accounting: accounting.* + platform.outbox_events + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_accounting') THEN
    EXECUTE format('CREATE ROLE svc_accounting LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_reconciliation: reconciliation.* + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_reconciliation') THEN
    EXECUTE format('CREATE ROLE svc_reconciliation LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_operations: operations.* + platform.inbox_events.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_operations') THEN
    EXECUTE format('CREATE ROLE svc_operations LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_payment: payment.* + platform.outbox_events + platform.jobs (SELECT via pool "payment");
  -- the job worker also touches payment.* and operations.* (see svc_job grants).
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_payment') THEN
    EXECUTE format('CREATE ROLE svc_payment LOGIN PASSWORD %L', svc_password);
  END IF;

  -- svc_relay: platform.outbox_events (SELECT FOR UPDATE, UPDATE). BYPASSRLS for cross-tenant
  -- poll + delivery; this worker's ONLY job is moving outbox events across tenant boundaries.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_relay') THEN
    EXECUTE format('CREATE ROLE svc_relay LOGIN PASSWORD %L BYPASSRLS', svc_password);
  END IF;

  -- svc_job: platform.jobs, platform.job_attempts, platform.outbox_events,
  -- platform.webhook_events, payment.*, operations.alerts, operations.audit_events.
  -- BYPASSRLS because it legitimately operates across tenants (watchdog, chain verify).
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_job') THEN
    EXECUTE format('CREATE ROLE svc_job LOGIN PASSWORD %L BYPASSRLS', svc_password);
  END IF;
END $$;

-- ── Schema-level grants ──────────────────────────────────────────────────
-- Schemas not listed have PUBLIC access revoked by default (no-op in PG, but explicit).

-- svc_gateway
GRANT USAGE ON SCHEMA identity TO svc_gateway;
GRANT USAGE ON SCHEMA operations TO svc_gateway;
GRANT USAGE ON SCHEMA platform TO svc_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO svc_gateway;
GRANT SELECT, INSERT ON operations.audit_events TO svc_gateway;
GRANT SELECT ON operations.providers TO svc_gateway;
GRANT SELECT, INSERT ON platform.webhook_events TO svc_gateway;
GRANT INSERT ON platform.jobs TO svc_gateway;

-- svc_wallet
GRANT USAGE ON SCHEMA wallet TO svc_wallet;
GRANT USAGE ON SCHEMA platform TO svc_wallet;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wallet TO svc_wallet;
GRANT INSERT ON platform.outbox_events TO svc_wallet;
GRANT INSERT ON platform.inbox_events TO svc_wallet;

-- svc_policy
GRANT USAGE ON SCHEMA policy TO svc_policy;
GRANT USAGE ON SCHEMA platform TO svc_policy;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA policy TO svc_policy;
GRANT INSERT ON platform.outbox_events TO svc_policy;
GRANT INSERT ON platform.inbox_events TO svc_policy;

-- svc_compliance
GRANT USAGE ON SCHEMA compliance TO svc_compliance;
GRANT USAGE ON SCHEMA platform TO svc_compliance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compliance TO svc_compliance;
GRANT INSERT ON platform.outbox_events TO svc_compliance;
GRANT INSERT ON platform.inbox_events TO svc_compliance;

-- svc_accounting
GRANT USAGE ON SCHEMA accounting TO svc_accounting;
GRANT USAGE ON SCHEMA platform TO svc_accounting;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA accounting TO svc_accounting;
GRANT INSERT ON platform.outbox_events TO svc_accounting;
GRANT INSERT ON platform.inbox_events TO svc_accounting;

-- svc_reconciliation
GRANT USAGE ON SCHEMA reconciliation TO svc_reconciliation;
GRANT USAGE ON SCHEMA platform TO svc_reconciliation;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reconciliation TO svc_reconciliation;
GRANT INSERT ON platform.inbox_events TO svc_reconciliation;

-- svc_operations
GRANT USAGE ON SCHEMA operations TO svc_operations;
GRANT USAGE ON SCHEMA platform TO svc_operations;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operations TO svc_operations;
GRANT INSERT ON platform.inbox_events TO svc_operations;

-- svc_payment
GRANT USAGE ON SCHEMA payment TO svc_payment;
GRANT USAGE ON SCHEMA platform TO svc_payment;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payment TO svc_payment;
GRANT INSERT ON platform.outbox_events TO svc_payment;
GRANT SELECT, INSERT ON platform.jobs TO svc_payment;
-- payment_reference_seq is used by the seed/reset path (ALTER SEQUENCE RESTART)
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA payment TO svc_payment;
ALTER SEQUENCE payment.payment_reference_seq OWNER TO svc_payment;

-- svc_relay: platform.outbox_events only (SELECT FOR UPDATE, UPDATE). BYPASSRLS already set.
GRANT USAGE ON SCHEMA platform TO svc_relay;
GRANT SELECT, UPDATE ON platform.outbox_events TO svc_relay;

-- svc_job: platform.* + payment.* + operations.alerts + operations.audit_events. BYPASSRLS already set.
GRANT USAGE ON SCHEMA platform TO svc_job;
GRANT USAGE ON SCHEMA payment TO svc_job;
GRANT USAGE ON SCHEMA operations TO svc_job;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO svc_job;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payment TO svc_job;
GRANT SELECT, INSERT, UPDATE ON operations.alerts TO svc_job;
GRANT SELECT ON operations.audit_events TO svc_job;
