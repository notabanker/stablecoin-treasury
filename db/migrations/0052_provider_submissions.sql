-- V8 Task 0.3 (Gate G1, LLM_TECHNICAL_HANDOFF_OPEN_FINDINGS.md Finding 1 -- CRITICAL):
-- provider submission was not crash-safe. The saga called adapter.submitTransfer() then
-- persisted provider_ref in a separate statement; a crash between those two steps left the
-- external transfer accepted but payment.payments.provider_ref still NULL, so a retry called
-- submitTransfer() again with no idempotency key -- a real provider would create a second,
-- duplicate external transfer.
--
-- This table is the durable pre-commit record: a row is inserted (status='pending') with a
-- deterministic idempotency key BEFORE the external call, so any retry -- whether the previous
-- attempt crashed before or after the provider accepted the transfer -- reuses the same key.
-- A real provider's own idempotency guarantee (and the simulated adapter's, see
-- packages/shared/adapters/custody.mjs) then prevents a duplicate transfer regardless of how
-- many times submitTransfer is called for the same payment.

CREATE TABLE payment.provider_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  -- payment.payments.id is TEXT (0005), not UUID. ON DELETE CASCADE mirrors
  -- payment_events/payment_execution_attempts (0016): demo reset/reseed deletes payments
  -- directly and must not need to remember this table too.
  payment_id TEXT NOT NULL REFERENCES payment.payments (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
  provider_ref TEXT,
  chain_ref TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, payment_id),
  UNIQUE (tenant_id, provider_id, idempotency_key)
);

CREATE INDEX provider_submissions_payment_idx ON payment.provider_submissions (payment_id);

ALTER TABLE payment.provider_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.provider_submissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 0033's "GRANT ... ON ALL TABLES IN SCHEMA payment" only covered tables that existed at grant
-- time (HANDOFF.md lesson: 0035/0036/0047). svc_payment and svc_job both already read/write
-- payment.* directly (svc_job runs the saga in-process; svc_payment serves /repair).
GRANT SELECT, INSERT, UPDATE ON payment.provider_submissions TO svc_payment;
GRANT SELECT, INSERT, UPDATE ON payment.provider_submissions TO svc_job;
