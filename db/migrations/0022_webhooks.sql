-- Webhook ingestion (V3.7)
-- Stores raw webhook payloads from custody providers. Deduplication by (provider_id, external_id).

CREATE TABLE IF NOT EXISTS platform.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL,
  tenant_id UUID NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  error TEXT,
  UNIQUE (provider_id, external_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON platform.webhook_events (status, received_at);
