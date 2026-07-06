-- V6 Epic 2.2 (Gate A2): row-level security, policy schema.
--
-- Policies check the transaction-local app.tenant_id set by packages/shared/db.mjs.
-- NULLIF(..., '') because current_setting(..., true) yields '' (not NULL) once a
-- transaction-local setting has expired on a pooled connection — and ''::uuid would
-- error; NULL compares false, so a missing context fails CLOSED (zero rows).
--
-- Table owners (migrations, seeds, test-admin connections) bypass RLS: FORCE is
-- deliberately not used. Services connect as svc_* roles (migration 0033) and are
-- fully subject to these policies. svc_relay/svc_job carry BYPASSRLS (cross-tenant
-- workers by design).

ALTER TABLE policy.policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy.policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE policy.policy_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy.policy_decisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
