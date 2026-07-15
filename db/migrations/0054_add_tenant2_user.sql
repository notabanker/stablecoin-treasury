-- Add a second user to tenant 2 for four-eyes demonstration (audit finding M6).
-- Tenant 2 now has two users: Erik Johansson (admin) and Maria Schmidt (analyst).

-- Password: demo123 (prototype SHA-256 hash matching 0025 pattern)
INSERT INTO identity.users (id, tenant_id, email, display_name, password_hash) VALUES
  ('b0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002',
   'maria@nordic.corp', 'Maria Schmidt',
   'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791')
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Grant Maria the analyst role
INSERT INTO identity.roles (tenant_id, name) VALUES
  ('00000000-0000-0000-0000-000000000002', 'Analyst')
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO identity.user_roles (user_id, role_id)
  SELECT 'b0000000-0000-0000-0000-000000000002', id
  FROM identity.roles
  WHERE tenant_id = '00000000-0000-0000-0000-000000000002'
    AND name = 'Analyst'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Seed basic role permissions for tenant 2 analyst
INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:create'), ('payment:approve'), ('payment:cancel'),
    ('payment:view'), ('wallet:read'), ('reconciliation:read')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000002'
  AND r.name = 'Analyst'
ON CONFLICT (role_id, permission) DO NOTHING;
