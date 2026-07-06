-- Fix: resolveAdapter in packages/shared/adapters/custody.mjs queries
-- operations.providers to resolve the adapter key for a given provider.
-- svc_job (the saga executor) needs SELECT on operations.providers.
GRANT SELECT ON operations.providers TO svc_job;
