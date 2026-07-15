-- V8 Task 0.2.2: recordDeliveryAttempt needs real backoff, not just an attempts counter --
-- without this column, a failing-but-not-yet-dead-lettered event gets re-attempted on every
-- single poll cycle (every RELAY_POLL_INTERVAL_MS), hammering a struggling consumer instead of
-- backing off. Mirrors platform.jobs' run_at scheduling (0014_jobs.sql, packages/shared/jobs.mjs
-- failJob: 250ms base, doubling, capped at 60s).

ALTER TABLE platform.outbox_events
  ADD COLUMN next_attempt_at TIMESTAMPTZ;
