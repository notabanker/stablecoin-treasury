-- V6 Epic 2.2: row-level security, operations schema. See 0037 for the pattern rationale.

ALTER TABLE operations.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operations.alerts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE operations.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operations.audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE operations.providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operations.providers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Deliberate carve-out: the gateway resolves provider -> tenant for incoming webhooks
-- BEFORE any tenant is known (the tenant IS the lookup result — same circularity as the
-- identity schema, which is excluded from RLS entirely for the same reason). svc_gateway
-- holds SELECT-only on this table (migration 0033), so the carve-out cannot write.
-- Permissive policies OR together: svc_gateway reads the registry across tenants; every
-- other role remains tenant-scoped by the policy above.
CREATE POLICY provider_registry_lookup ON operations.providers
  FOR SELECT TO svc_gateway
  USING (true);
