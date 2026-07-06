-- V6 Epic 2.2: row-level security, payment schema. See 0037 for the pattern rationale.

ALTER TABLE payment.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE payment.payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE payment.payment_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_approvals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE payment.payment_execution_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.payment_execution_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE payment.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment.idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
