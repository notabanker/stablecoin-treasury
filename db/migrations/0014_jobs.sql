-- Durable job queue: long-running or async work (saga execution, expiry sweeps, idempotency
-- cleanup) is enqueued as a row in platform.jobs. The job worker polls with FOR UPDATE SKIP
-- LOCKED, runs the handler, and updates the row on completion or failure.
--
-- Every attempt is logged in platform.job_attempts so the repair UI (M3.3) can show full
-- attempt history with error details.

CREATE TABLE IF NOT EXISTS platform.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_lettered')),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  locked_by TEXT
);

CREATE INDEX IF NOT EXISTS jobs_poll_idx
  ON platform.jobs (status, run_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS platform.job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES platform.jobs (id),
  attempt_no INT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'success', 'error', 'dead_lettered')),
  error TEXT,
  duration_ms INT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON platform.job_attempts (job_id);
