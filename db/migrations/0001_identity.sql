-- Identity skeleton. Full users/roles/permissions land with the M4 auth work; this migration
-- exists now so every later table can carry a real tenant_id FK from its first migration
-- instead of retrofitting tenancy onto a live ledger later.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO identity.tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Vega Industries SE (default tenant)')
ON CONFLICT (id) DO NOTHING;
