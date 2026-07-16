-- Fix M6: 0055 replaced Maria's SHA-256 hash with scrypt but the hash did not verify demo123.
-- Regenerate with hashPassword("demo123") from packages/shared/auth.mjs.

UPDATE identity.users
SET password_hash = 'scrypt$16384$8$1$wjeB70IhqrvNDjEsG6VJPA$q6U24W8-41hd_Bxdu0tP_ACq_E2XYjKXAXZxzfHmXC5m3w-dCBWvrFrTXCt552ZJLj1RZzbM-3Ua-GuK-1SQXw'
WHERE id = 'b0000000-0000-0000-0000-000000000002'
  AND tenant_id = '00000000-0000-0000-0000-000000000002';