-- V6 Epic 1: Real four-eyes approvals.
-- Replaces the anonymous approvals counter with an identity-tracked, append-only model.

-- Approvals table — one row per (payment, approver), append-only.
CREATE TABLE IF NOT EXISTS payment.payment_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  payment_id TEXT NOT NULL REFERENCES payment.payments (id),
  approver_id TEXT NOT NULL,
  approver_display TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, approver_id)
);

CREATE INDEX IF NOT EXISTS payment_approvals_payment_idx ON payment.payment_approvals (payment_id);

REVOKE UPDATE, DELETE ON payment.payment_approvals FROM PUBLIC;

-- Track who created each payment (nullable: legacy rows have no creator identity).
ALTER TABLE payment.payments ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Backfill synthetic approval rows for existing payments that have approvals > 0.
-- The marker "legacy:unknown:n" identifies pre-V6 approvals where identity was not recorded.
DO $$
DECLARE
  pay RECORD;
  i INT;
BEGIN
  FOR pay IN
    SELECT id, tenant_id, approvals
    FROM payment.payments
    WHERE approvals > 0
  LOOP
    FOR i IN 1..pay.approvals LOOP
      INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display)
      VALUES (pay.tenant_id, pay.id, format('legacy:unknown:%s', i), 'Pre-V6 approval (identity not recorded)')
      ON CONFLICT (payment_id, approver_id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
