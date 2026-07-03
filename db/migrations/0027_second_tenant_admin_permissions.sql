-- Keep tenant 2's demo Admin role aligned with the default tenant Admin permission surface.

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
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000002'
  AND r.name = 'Admin'
ON CONFLICT (role_id, permission) DO NOTHING;
