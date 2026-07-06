-- Fix: provider_statements unique constraint was not tenant-scoped (0047 oversight).
-- One tenant could make another tenant's valid provider statement look like a duplicate.
-- The index already exists (tenant_id is included in the statement_lines index),
-- so this is a clean drop-and-recreate.

ALTER TABLE reconciliation.provider_statements
  DROP CONSTRAINT IF EXISTS provider_statements_provider_id_external_id_key;

ALTER TABLE reconciliation.provider_statements
  ADD CONSTRAINT provider_statements_tenant_provider_external_unique
  UNIQUE (tenant_id, provider_id, external_id);
