-- V6 Epic 2.2: row-level security, compliance schema. See 0037 for the pattern rationale.

ALTER TABLE compliance.counterparties ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON compliance.counterparties
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
