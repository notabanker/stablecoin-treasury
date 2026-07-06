-- Fix: the gateway webhook path enqueues settlement jobs via enqueueJob, which uses
-- INSERT ... RETURNING * on platform.jobs — RETURNING needs SELECT on the returned
-- columns (same class as 0035). svc_gateway previously had INSERT only.
--
-- Found by running the integration suite under real service roles: the Epic 2.1 test
-- harness had a duplicate-key bug in tests/helpers/stack.mjs that silently kept test
-- stacks on the admin connection, so this gap never surfaced in tests until the harness
-- was fixed (dev-stack smoke missed it because the smoke flow does not deliver a
-- settlement webhook).
GRANT SELECT ON platform.jobs TO svc_gateway;
