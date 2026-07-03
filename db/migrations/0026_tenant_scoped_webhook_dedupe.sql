-- Webhook event ids are only unique inside a tenant/provider context. A provider/external id
-- collision in one tenant must not block the same provider/external id in another tenant.

ALTER TABLE platform.webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_provider_id_external_id_key;

ALTER TABLE platform.webhook_events
  ADD CONSTRAINT webhook_events_tenant_provider_external_key
  UNIQUE (tenant_id, provider_id, external_id);
