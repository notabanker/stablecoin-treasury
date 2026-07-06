-- V6 Epic 2.2: row-level security, platform schema. See 0037 for the pattern rationale.
--
-- platform.inbox_events deliberately has NO policy: it carries no tenant_id column
-- (PK is event_id + consumer, FK'd to outbox_events which is tenant-scoped).
-- svc_relay and svc_job carry BYPASSRLS (migration 0033): they poll and deliver
-- across all tenants by design; these policies bind the domain services and gateway.

ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE platform.outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.outbox_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE platform.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.webhook_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
