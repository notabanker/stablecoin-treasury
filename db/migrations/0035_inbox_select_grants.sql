-- Fix: claimInboxEvent uses INSERT ... RETURNING event_id which needs SELECT
-- on the returned column. Grant SELECT on platform.inbox_events to services that
-- use withInboxDedup (operations, reconciliation) and all domain services that
-- emit outbox events (which are consumed via inbox dedup).
GRANT SELECT ON platform.inbox_events TO svc_operations;
GRANT SELECT ON platform.inbox_events TO svc_reconciliation;
GRANT SELECT ON platform.inbox_events TO svc_wallet;
GRANT SELECT ON platform.inbox_events TO svc_policy;
GRANT SELECT ON platform.inbox_events TO svc_compliance;
GRANT SELECT ON platform.inbox_events TO svc_accounting;
GRANT SELECT ON platform.inbox_events TO svc_payment;
GRANT SELECT ON platform.inbox_events TO svc_job;
