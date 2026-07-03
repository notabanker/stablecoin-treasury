CREATE SCHEMA IF NOT EXISTS wallet;

CREATE TABLE IF NOT EXISTS wallet.legal_entities (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  erp_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet.assets (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  issuer TEXT NOT NULL,
  chain TEXT NOT NULL,
  classification TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Enabled', 'Reporting only', 'Disabled')),
  risk TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet.wallets (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  entity_id TEXT NOT NULL REFERENCES wallet.legal_entities (id),
  provider_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES wallet.assets (id),
  address TEXT NOT NULL,
  custody TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Active', 'Suspended', 'Closed')),
  -- NUMERIC gives correct storage precision for money; the roundMoney() float-rounding issue
  -- found in unit testing lives in the application layer's arithmetic, not storage, and is
  -- fully closed only when the ledger (M2) makes this column a derived read model.
  balance NUMERIC(20, 2) NOT NULL CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet.debit_operations (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  wallet_id TEXT NOT NULL REFERENCES wallet.wallets (id),
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(20, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
