-- Seed permissions for each role (V3.2 RBAC).
-- Permission format: "resource:action" (e.g. "payment:create", "admin:manage_users")

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:create'),
    ('payment:approve'),
    ('payment:execute'),
    ('payment:cancel'),
    ('payment:view'),
    ('policy:update'),
    ('reconciliation:resolve'),
    ('reconciliation:simulate'),
    ('operations:toggle_provider'),
    ('operations:simulate_incident'),
    ('accounting:export'),
    ('admin:reset'),
    ('admin:manage_users'),
    ('audit:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'Admin'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:create'),
    ('payment:approve'),
    ('payment:execute'),
    ('payment:cancel'),
    ('payment:view'),
    ('policy:update'),
    ('reconciliation:resolve'),
    ('reconciliation:simulate'),
    ('accounting:export'),
    ('audit:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'TreasuryAdmin'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:create'),
    ('payment:view'),
    ('audit:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'TreasuryOperator'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:approve'),
    ('payment:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'Approver'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:view'),
    ('reconciliation:resolve'),
    ('audit:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'ComplianceOps'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:view'),
    ('audit:view')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000001'
  AND r.name = 'Auditor'
ON CONFLICT (role_id, permission) DO NOTHING;
