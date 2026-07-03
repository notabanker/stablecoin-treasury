CREATE SCHEMA IF NOT EXISTS compliance;

CREATE TABLE IF NOT EXISTS compliance.counterparties (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Approved', 'Review', 'Blocked')),
  risk TEXT NOT NULL,
  asset TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
