CREATE SCHEMA IF NOT EXISTS policy;

-- Single current-state row per tenant for M1. Versioned policy history with maker/checker
-- approval (backlog 6.7) is deferred past this port; policy_decisions below gets the append-only
-- treatment now because it's cheap to add and directly supports the audit-immutability goal.
CREATE TABLE IF NOT EXISTS policy.policies (
  tenant_id UUID PRIMARY KEY REFERENCES identity.tenants (id),
  approval_threshold NUMERIC(20, 2) NOT NULL CHECK (approval_threshold >= 0),
  second_approval_threshold NUMERIC(20, 2) NOT NULL CHECK (second_approval_threshold >= 0),
  hard_transfer_limit NUMERIC(20, 2) NOT NULL CHECK (hard_transfer_limit > 0),
  concentration_limit NUMERIC(5, 4) NOT NULL CHECK (concentration_limit > 0 AND concentration_limit <= 1),
  allowed_assets TEXT[] NOT NULL,
  allowed_providers TEXT[] NOT NULL,
  require_screening BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approval_threshold <= second_approval_threshold)
);

CREATE TABLE IF NOT EXISTS policy.policy_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  payment_id TEXT NOT NULL,
  decision_status TEXT NOT NULL CHECK (decision_status IN ('Clear', 'Review', 'Blocked')),
  detail TEXT NOT NULL,
  checks JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE UPDATE, DELETE ON policy.policy_decisions FROM PUBLIC;
