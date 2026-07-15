# Operational Runbooks

## Payment Stuck in Executing

**Symptoms:** Payment status remains "Executing" for > 2 minutes. No saga completion.

**Detection:**
```sql
SELECT id, reference, status, created_at
FROM payment.payments
WHERE status = 'Executing'
  AND created_at < now() - INTERVAL '2 minutes';
```

**Safe remediation:**
1. Check job status: `GET /api/repair` — look for the payment and its job state
2. If job is dead-lettered: `POST /api/repair/:id/retry`
3. If job is pending/running: wait for worker to pick it up
4. If no job exists: `POST /api/repair/:id/retry` to enqueue a new one

**Escalation:** If repair retry fails (503/500), check downstream services:
```bash
curl http://127.0.0.1:4101/health  # wallet
curl http://127.0.0.1:4105/health  # accounting
curl http://127.0.0.1:4106/health  # reconciliation
```

## Payment Failed

**Symptoms:** Payment status is "Failed" but execution should have succeeded.

**Detection:**
```sql
SELECT id, reference, status
FROM payment.payments
WHERE status = 'Failed';
```

**Safe remediation:**
1. Check execution attempts: `GET /api/payments/:id/attempts`
2. Check job error: see `last_error` in repair queue response
3. If downstream service was temporarily down: retry via repair endpoint
4. If debit failed due to insufficient balance: cancel payment, top up wallet, create new
5. If policy blocked: check policy configuration

**Escalation:** Never directly mutate `payment.payments.status` or `wallet.ledger_entries`. Always go through the service API.

## Dead-Letter Job

**Symptoms:** Job appears in dead-letter state. No automatic retry. Alert created.

**Detection:**
```sql
SELECT * FROM platform.jobs WHERE status = 'dead_lettered';
```

**Safe remediation:**
1. Identify the payment from job payload
2. Check root cause: `last_error` column in platform.jobs
3. For `execute-payment` jobs: ensure downstream services are healthy
4. `POST /api/repair/:paymentId/retry` to enqueue a new saga job
5. Monitor for success

**Escalation:** Persistent dead-letter after 3 manual retries → investigate downstream service health.

## Outbox Delivery Failure

**Symptoms:** Audit events, alerts, or reconciliation exceptions not appearing. Relay worker logs `relay_delivery_failed`.

**Detection:**
```sql
-- Still retrying (transient failures, or not yet attempted):
SELECT count(*) FROM platform.outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL;
-- Dead-lettered (permanently failed after RELAY_MAX_RETRIES attempts, default 5):
SELECT id, event_type, attempts, last_error, dead_lettered_at
FROM platform.outbox_events WHERE dead_lettered_at IS NOT NULL;
```

**Safe remediation:**
1. Check relay worker health and dead-letter count: `curl http://127.0.0.1:9101/metrics` (`deadLetterCount`, `unpublishedCount`, `outboxLagMs`)
2. Check consumer service health (operations, reconciliation)
3. If relay worker crashed: restart it (`npm run dev` handles this)
4. Transient failures remain in `published_at IS NULL, dead_lettered_at IS NULL` state and are retried automatically; they no longer starve delivery of other events once dead-lettered (V8 Task 0.2, audit finding H3)
5. For dead-lettered rows: `last_error` names the root cause (e.g. a consumer 4xx/5xx). Fix the root cause, then manually clear `dead_lettered_at` and reset `attempts = 0` on the affected row(s) to re-queue — there is no automated replay tool yet (0.2.6, deferred)

**Escalation:** If `deadLetterCount` is non-zero, the ops-watchdog raises an "Outbox dead-letter queue non-empty" alert (same pattern as the jobs DLQ alert). If events remain unpublished (not dead-lettered) for > 1 hour, check relay worker logs for systemic failures.

## Webhook Signature Failure

**Symptoms:** Webhook endpoint returns 401, provider reports delivery failures.

**Detection:**
```sql
SELECT * FROM platform.webhook_events
WHERE signature_valid = false
  AND received_at > now() - INTERVAL '1 hour';
```

**Safe remediation:**
1. Verify provider secret in `operations.providers.webhook_secret`
2. Check signature algorithm (HMAC-SHA256 over JSON body)
3. Use CLI to verify: `echo -n '{"eventId":"x"}' | openssl dgst -sha256 -hmac "<secret>"`
4. Update secret if rotated

**Escalation:** Never accept unsigned payloads. Do not commit webhook secrets.

## Tenant Isolation Sanity Check

**Detection:**
```sql
SELECT p.status, count(*)
FROM payment.payments p
JOIN identity.tenants t ON p.tenant_id = t.id
GROUP BY p.status, t.name
ORDER BY t.name, p.status;
```

**Remediation:** Cross-tenant access is prevented by application-layer tenant_id filtering. Postgres RLS planned for M4.

## Audit Chain Break

Alert: `Audit chain integrity violation` (raised by the nightly `audit-chain-verify` job;
severity High). The alert detail names the failure reason, `chain_seq`, and event id.

What the chain proves: every `operations.audit_events` row commits to its predecessor via
`prev_hash`/`row_hash` (sha256, canonical SQL serialization — see migration 0032) with a
gapless per-tenant `chain_seq`. A break means a recorded event was edited, relinked, or an
interior row was deleted after the fact.

Known limitations (do not over-claim):
- Deleting the NEWEST rows of a tenant's chain (truncation) is not detectable without
  external anchoring / WORM offload (planned, backlog 6.5).
- The chain proves integrity of recorded events, not completeness: `emitSecurityAudit` is
  fail-open by design (an audit insert failure never blocks login/logout) and logs
  `security_audit_insert_failed` — watch for those in logs.

Response:
1. Reproduce and bound the damage:
   `node scripts/verify-audit-chain.mjs` (uses `DATABASE_URL`) — the JSON output names the
   first broken row: `{ id, tenantId, chainSeq, reason }`.
   - `row_hash_mismatch` — that row's content was edited.
   - `prev_hash_mismatch` — rows were relinked/reordered.
   - `sequence_gap` / `missing_genesis` — interior rows were deleted.
2. Everything before the named `chain_seq` in that tenant's chain is still proven intact;
   treat that row and everything after as suspect.
3. Preserve evidence before touching anything: `pg_dump --table=operations.audit_events`
   plus the latest base backup for comparison (see Backup / Restore Quick Reference).
4. This is a security incident, not an ops repair: DB-level tampering implies write access
   to the database. Rotate DB credentials, review `pg_stat_activity`/connection logs, and
   escalate. Do NOT "fix" the chain by recomputing hashes — that destroys the evidence.
5. Expected false positive: none. Demo resets rebuild the tenant-1 chain atomically and
   verify clean; a break is never routine.

The alert closes automatically on the next verify cycle only if the chain verifies clean
again (e.g. after a restore); it never closes while the break persists.

## DB Invariant Checks

Run periodically:
```sql
-- Negative balances (must be 0)
SELECT * FROM wallet.wallet_balances WHERE balance < 0;

-- Unbalanced ledger transactions (must be 0)
SELECT lt.id, SUM(CASE WHEN le.direction='debit' THEN le.amount ELSE -le.amount END) AS imbalance
FROM wallet.ledger_transactions lt
JOIN wallet.ledger_entries le ON le.transaction_id = lt.id
GROUP BY lt.id
HAVING SUM(CASE WHEN le.direction='debit' THEN le.amount ELSE -le.amount END) <> 0;

-- Null tenant_id in platform tables (must be 0)
SELECT count(*) FROM platform.jobs WHERE tenant_id IS NULL;
SELECT count(*) FROM platform.outbox_events WHERE tenant_id IS NULL;

-- Approvals integrity (must be 0): no payment claims more approvals than it has rows for
SELECT count(*) FROM payment.payments p
WHERE p.approvals > (SELECT COUNT(DISTINCT approver_id)
                     FROM payment.payment_approvals a WHERE a.payment_id = p.id);
```

Audit chain (must exit 0):
```bash
node scripts/verify-audit-chain.mjs
```

## Service Restart Procedure

1. `kill -SIGTERM <pid>` for each service process (graceful)
2. Workers (relay, job) handle in-flight jobs before exit
3. Gateway drains active connections
4. Restart: `npm run dev` starts all services + workers

## Backup / Restore Quick Reference

Backup:
```bash
pg_dump -U postgres -h 127.0.0.1 treasury_dev > backup_$(date +%Y%m%d_%H%M%S).sql
```

Restore:
```bash
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE treasury_restored"
psql -U postgres -h 127.0.0.1 treasury_restored < backup.sql
```

Post-restore: run migration checker to verify schema version.
