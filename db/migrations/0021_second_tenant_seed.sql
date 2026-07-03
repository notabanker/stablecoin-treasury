-- Second tenant for cross-tenant isolation testing (V3.3)

INSERT INTO identity.tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000002', 'Nordic Holdings AB (tenant 2)')
ON CONFLICT (id) DO NOTHING;

-- Password: demo123 (prototype hash upgraded to a distinct salted scrypt hash in 0025)
INSERT INTO identity.users (id, tenant_id, email, display_name, password_hash) VALUES
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'admin@nordic-holdings.com', 'Erik Johansson',
   'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791')
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Give tenant 2 the same roles
INSERT INTO identity.roles (tenant_id, name) VALUES
  ('00000000-0000-0000-0000-000000000002', 'Admin')
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO identity.user_roles (user_id, role_id)
  SELECT 'b0000000-0000-0000-0000-000000000001', id
  FROM identity.roles
  WHERE tenant_id = '00000000-0000-0000-0000-000000000002'
    AND name = 'Admin'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Seed basic role permissions for tenant 2 admin
INSERT INTO identity.role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM identity.roles r
CROSS JOIN (
  VALUES
    ('payment:create'), ('payment:approve'), ('payment:execute'),
    ('payment:cancel'), ('payment:view'), ('admin:reset')
) AS p(permission)
WHERE r.tenant_id = '00000000-0000-0000-0000-000000000002'
  AND r.name = 'Admin'
ON CONFLICT (role_id, permission) DO NOTHING;
