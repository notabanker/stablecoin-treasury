-- Tracks each step of a payment execution saga. Every attempt is append-only so the repair
-- UI (M3.3) can show full execution history including which step failed and why.

CREATE TABLE IF NOT EXISTS payment.payment_execution_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  payment_id TEXT NOT NULL REFERENCES payment.payments (id),
  job_id UUID,
  step TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'success', 'error', 'compensating', 'compensated')),
  error TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exe_attempts_payment_idx ON payment.payment_execution_attempts (payment_id);
