-- Transactional outbox: replaces every fire-and-forget bestEffortPost with an INSERT that
-- shares the service's own state-change transaction. If the transaction commits, the event is
-- durable; if it rolls back, the event is discarded along with the state change -- no phantom
-- notifications and no silently-dropped side effects.
--
-- The relay worker (services/relay-worker/src/index.mjs) polls unpublished rows and delivers
-- them to the target consumer via HTTP POST; on success it sets published_at. On failure it
-- retries with exponential backoff; exhausted events surface as alerts.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx
  ON platform.outbox_events (created_at)
  WHERE published_at IS NULL;

-- Per-consumer inbox: each event delivery is recorded here BEFORE the consumer processes it.
-- The UNIQUE constraint on (event_id, consumer) makes delivery exactly-once at the effect
-- level even when the relay redelivers at-least-once.
CREATE TABLE IF NOT EXISTS platform.inbox_events (
  event_id UUID NOT NULL REFERENCES platform.outbox_events (id),
  consumer TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
