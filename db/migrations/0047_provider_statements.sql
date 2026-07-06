-- V6 Epic 5.2 (Gate A5): provider statement ingestion.
-- Reconciliation gains an external view to reconcile AGAINST: provider statements and
-- their lines. Until now recon rows derived only from our own payment events.
--
-- NOTE: grants live in this file because GRANT ... ON ALL TABLES (0033) only covers
-- tables that existed at grant time; new tables need explicit grants. RLS policies
-- follow the 0037 pattern (fail-closed NULLIF guard).

CREATE TABLE IF NOT EXISTS reconciliation.provider_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  provider_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent ingestion: re-delivering the same statement is a no-op.
  UNIQUE (provider_id, external_id)
);

CREATE TABLE IF NOT EXISTS reconciliation.statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  statement_id UUID NOT NULL REFERENCES reconciliation.provider_statements (id),
  provider_ref TEXT NOT NULL,
  amount NUMERIC(20, 2) NOT NULL,
  asset TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  match_status TEXT NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending', 'matched', 'exception')),
  match_confidence NUMERIC(3, 2),
  raw JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS statement_lines_statement_idx ON reconciliation.statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS statement_lines_provider_ref_idx ON reconciliation.statement_lines (tenant_id, provider_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation.provider_statements TO svc_reconciliation;
GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation.statement_lines TO svc_reconciliation;
-- Ingestion enqueues the match-statement job (INSERT ... RETURNING needs SELECT — 0035/0036 lesson).
GRANT SELECT, INSERT ON platform.jobs TO svc_reconciliation;
-- The match-statement job runs in the job-worker (svc_job), not the reconciliation service.
GRANT SELECT, INSERT, UPDATE ON reconciliation.provider_statements TO svc_job;
GRANT SELECT, INSERT, UPDATE ON reconciliation.statement_lines TO svc_job;

ALTER TABLE reconciliation.provider_statements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reconciliation.provider_statements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE reconciliation.statement_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reconciliation.statement_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
