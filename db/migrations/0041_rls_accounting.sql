-- V6 Epic 2.2: row-level security, accounting schema. See 0037 for the pattern rationale.

ALTER TABLE accounting.journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting.journal_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
