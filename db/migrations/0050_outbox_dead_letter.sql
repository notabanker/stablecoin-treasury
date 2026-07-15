-- V8 Task 0.2.1 (audit finding H3): the outbox relay had no poison-event handling --
-- recordDeliveryAttempt was a no-op and a permanently-failing event retried forever, and with
-- BATCH_SIZE=20 oldest-first selection, twenty such events would starve delivery for every
-- tenant. Mirrors the attempts/last_error dead-letter pattern already used by platform.jobs
-- (0014_jobs.sql), scoped down to what the outbox actually needs: max_attempts is a single
-- relay-wide policy (RELAY_MAX_RETRIES), not a per-job-type setting, so no max_attempts column.

ALTER TABLE platform.outbox_events
  ADD COLUMN attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN last_error TEXT,
  ADD COLUMN dead_lettered_at TIMESTAMPTZ;

-- Replace the unpublished-events partial index so dead-lettered rows drop out of the relay's
-- poll set entirely instead of permanently occupying LIMIT 20 slots.
DROP INDEX IF EXISTS platform.outbox_events_unpublished_idx;
CREATE INDEX outbox_events_unpublished_idx
  ON platform.outbox_events (created_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
