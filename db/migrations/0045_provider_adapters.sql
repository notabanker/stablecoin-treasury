-- Epic 5.1: Provider adapter columns for the custody adapter seam.
-- capabilities: JSON describing what the provider supports (e.g. {"custody": true, "screening": false}).
-- environment: 'sandbox' for test/simulated providers, 'prod' for live. Defaults to sandbox.
-- adapter: registry key for the CustodyAdapter implementation. 'simulated' is the built-in default.

ALTER TABLE operations.providers ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';
ALTER TABLE operations.providers ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'sandbox'
  CHECK (environment IN ('sandbox', 'prod'));
ALTER TABLE operations.providers ADD COLUMN IF NOT EXISTS adapter TEXT NOT NULL DEFAULT 'simulated';

-- Seed existing providers as sandbox with simulated adapter.
UPDATE operations.providers SET environment = 'sandbox', adapter = 'simulated'
  WHERE environment = 'sandbox' AND adapter = 'simulated';
