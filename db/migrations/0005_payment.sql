CREATE SCHEMA IF NOT EXISTS payment;

-- Backs unique, gap-tolerant payment references without the app-level counter race that existed
-- before this port (two concurrent creates reading the same "current max" and computing the same
-- next reference). A DB sequence is inherently race-free under concurrent INSERTs.
CREATE SEQUENCE IF NOT EXISTS payment.payment_reference_seq START 1005;

CREATE TABLE IF NOT EXISTS payment.payments (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  reference TEXT NOT NULL,
  type TEXT NOT NULL,
  source_wallet_id TEXT NOT NULL,
  counterparty_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  fee NUMERIC(20, 2) NOT NULL CHECK (fee >= 0),
  -- The full formal state machine (Draft/PendingApproval/.../RepairRequired) is M2 scope; this
  -- CHECK enforces the status vocabulary already in use by the ported application code so the
  -- database rejects typos and out-of-band writes even before the transition table exists.
  status TEXT NOT NULL CHECK (
    status IN ('Pending approval', 'Approved', 'Executing', 'Settled', 'Blocked', 'Cancelled', 'Failed')
  ),
  approvals INT NOT NULL DEFAULT 0 CHECK (approvals >= 0),
  required_approvals INT NOT NULL DEFAULT 0 CHECK (required_approvals >= 0),
  screen_result TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  chain_ref TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  row_version INT NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, reference)
);

CREATE INDEX IF NOT EXISTS payments_tenant_status_idx ON payment.payments (tenant_id, status);

-- Append-only transition history. Populated from M2 onward once the state machine writes here;
-- the table exists now so M2 doesn't need another migration to add it.
CREATE TABLE IF NOT EXISTS payment.payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  payment_id TEXT NOT NULL REFERENCES payment.payments (id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason_code TEXT,
  actor TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE UPDATE, DELETE ON payment.payment_events FROM PUBLIC;

CREATE TABLE IF NOT EXISTS payment.idempotency_keys (
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  payment_id TEXT REFERENCES payment.payments (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key, action)
);
