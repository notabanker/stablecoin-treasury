-- Backfill csrf_token for legacy sessions and enforce NOT NULL.
-- Legacy null rows are deleted: a token the browser never received is unusable anyway.
-- This forces a clean re-login for any orphaned legacy sessions.
-- Runtime strictness (verifyCsrf) is kept as defense in depth; it also covers empty-string tokens.

DELETE FROM identity.sessions WHERE csrf_token IS NULL;

ALTER TABLE identity.sessions ALTER COLUMN csrf_token SET NOT NULL;
