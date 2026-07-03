-- Identity tables: users, roles, permissions, sessions.
-- Users and sessions land now (V3.1). Roles/permissions land with RBAC (V3.2).
-- Every table carries tenant_id so multi-tenancy works from day one.

CREATE TABLE IF NOT EXISTS identity.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS identity.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_token_idx ON identity.sessions (token);

CREATE TABLE IF NOT EXISTS identity.roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  name TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS identity.role_permissions (
  role_id UUID NOT NULL REFERENCES identity.roles (id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS identity.user_roles (
  user_id UUID NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES identity.roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
