CREATE SCHEMA IF NOT EXISTS reconciliation;

CREATE TABLE IF NOT EXISTS reconciliation.reconciliation_rows (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  payment_id TEXT NOT NULL,
  source TEXT NOT NULL,
  issue TEXT NOT NULL,
  amount NUMERIC(20, 2) NOT NULL,
  asset TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Open', 'Resolved')),
  owner TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reconciliation_rows_payment_idx ON reconciliation.reconciliation_rows (payment_id);
