-- Seed identity data for V3.1 auth.
-- Default password for all seed users: "demo123"
-- Initial prototype rows are upgraded to per-user salted scrypt hashes in 0025.

INSERT INTO identity.roles (tenant_id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TreasuryAdmin'),
  ('00000000-0000-0000-0000-000000000001', 'TreasuryOperator'),
  ('00000000-0000-0000-0000-000000000001', 'Approver'),
  ('00000000-0000-0000-0000-000000000001', 'ComplianceOps'),
  ('00000000-0000-0000-0000-000000000001', 'Auditor'),
  ('00000000-0000-0000-0000-000000000001', 'Admin')
ON CONFLICT (tenant_id, name) DO NOTHING;

-- Password for both seed users: demo123 (prototype hash upgraded in 0025)
INSERT INTO identity.users (id, tenant_id, email, display_name, password_hash) VALUES
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'marta@vega-industries.com', 'Marta Klein',
   'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791')
ON CONFLICT (tenant_id, email) DO NOTHING;

INSERT INTO identity.users (id, tenant_id, email, display_name, password_hash) VALUES
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'approver@vega-industries.com', 'Klaus Mueller',
   'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791')
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Assign default admin user to Admin role
INSERT INTO identity.user_roles (user_id, role_id)
  SELECT 'a0000000-0000-0000-0000-000000000001', id
  FROM identity.roles
  WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
    AND name = 'Admin'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Assign approver user to Approver role
INSERT INTO identity.user_roles (user_id, role_id)
  SELECT 'a0000000-0000-0000-0000-000000000002', id
  FROM identity.roles
  WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
    AND name = 'Approver'
ON CONFLICT (user_id, role_id) DO NOTHING;
