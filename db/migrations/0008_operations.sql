CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS operations.providers (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  authority TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Operational', 'Degraded')),
  latency_ms INT NOT NULL,
  uptime NUMERIC(5, 2) NOT NULL,
  assets TEXT[] NOT NULL,
  routes TEXT[] NOT NULL,
  incident TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS operations.alerts (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  severity TEXT NOT NULL CHECK (severity IN ('Low', 'Medium', 'High')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit events are the system of record for who-did-what. Before this port they were plain
-- mutable JSON rows appended by an unauthenticated endpoint -- REVOKE here is necessary but not
-- sufficient; the M4 auth work still needs to stop unauthenticated callers from reaching this
-- table's INSERT path at all. This is the storage half of that fix.
CREATE TABLE IF NOT EXISTS operations.audit_events (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE UPDATE, DELETE ON operations.audit_events FROM PUBLIC;
