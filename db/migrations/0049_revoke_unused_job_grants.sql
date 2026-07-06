-- Simplification audit 2026-07-06 (docs/V6_AUDIT_REPORT.md M3, partial): 0047 granted
-- svc_job direct DML on the statement tables, but the match-statement job orchestrates
-- over HTTP (servicePost to the reconciliation service) and never touches these tables —
-- the grants were dead privilege, and 0047's comment asserting the opposite was wrong.
-- The reconciliation service (svc_reconciliation) keeps its grants; the worker needs none.
REVOKE SELECT, INSERT, UPDATE ON reconciliation.provider_statements FROM svc_job;
REVOKE SELECT, INSERT, UPDATE ON reconciliation.statement_lines FROM svc_job;
