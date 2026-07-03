ALTER TABLE identity.sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;
