-- F3 (audit-fixes 2026-08-09): formalize read access to payment routes as an
-- auditable permission. Approved matrix: payment:read for all four tenant roles
-- (analyst, approver, treasury-manager, admin). GET /api/payments/:id/attempts,
-- GET /api/payments/:id/approvals and GET /api/repair were previously guard()-only;
-- the gateway now enforces payment:read (repair additionally payment:execute).
-- "treasury-manager" maps to tenant 1's TreasuryAdmin role (the execute-holding
-- manager role in the seed). Roles outside the matrix (TreasuryOperator,
-- ComplianceOps, Auditor) are denied by omission per the approved matrix.

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, 'payment:read'
FROM identity.roles r
WHERE (r.tenant_id, r.name) IN (
  ('00000000-0000-0000-0000-000000000001', 'Admin'),
  ('00000000-0000-0000-0000-000000000001', 'Approver'),
  ('00000000-0000-0000-0000-000000000001', 'TreasuryAdmin'),
  ('00000000-0000-0000-0000-000000000002', 'Admin'),
  ('00000000-0000-0000-0000-000000000002', 'Analyst')
)
ON CONFLICT (role_id, permission) DO NOTHING;
