-- Replace prototype unsalted SHA-256 seed-password hashes with per-user salted scrypt hashes.
-- Seed password remains "demo123" for local demo users only.

UPDATE identity.users
SET password_hash = CASE id
  WHEN 'a0000000-0000-0000-0000-000000000001' THEN 'scrypt$16384$8$1$1AI_rDx0dnv3UCDr5mO_Cg$eXUf_JvGrqeUa5c9tx2TOc-2y16W5oOTg4qtqiC3g_pv07nV5IBS_-w5pMxJm74iTVq2TNPzL-_FAIItK4w-uw'
  WHEN 'a0000000-0000-0000-0000-000000000002' THEN 'scrypt$16384$8$1$YL7-C6hsHIZHMBADTYH01Q$mWH9LBfEHZjynXJ8kj_folcYramdFHPmh6vaSsspZ5dfL-kUMTxXYJglk7HUBQxh56HdXX_8QU2dftGpZGqezw'
  WHEN 'b0000000-0000-0000-0000-000000000001' THEN 'scrypt$16384$8$1$t0VLD7XRwCS2Yqy60_5Fng$4smkCAr2SImR_hJYYZpVht4aQXxcYXP4y1heEzrM6XgtliWuZoShbXQgln5WpSGf6pgYp6rZFrkmteJ5mAEEXg'
  ELSE password_hash
END
WHERE id IN (
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  'b0000000-0000-0000-0000-000000000001'
);
