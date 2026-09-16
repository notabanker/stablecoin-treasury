# Operational Runbooks

Never mutate `payment.payments.status`, ledger entries, or audit rows directly to "fix" a
problem — always go through a service API or job so controls and audit stay intact.

## Audit Chain Break

**Signal:** `Audit chain integrity violation` alert (severity High) raised by the nightly
`audit-chain-verify` job; detail names the reason and `chain_seq`.

**What it means:** each `operations.audit_events` row commits to its predecessor via
`prev_hash`/`row_hash` (sha256, canonical SQL serialization) with a gapless per-tenant
`chain_seq`. A break means recorded events were edited, relinked, or deleted.

**Response:**

1. Reproduce and bound: `node scripts/verify-audit-chain.mjs` — the JSON output names the
   first broken row `{ id, tenantId, chainSeq, reason }`. `row_hash_mismatch` = edited row;
   `prev_hash_mismatch` = relinked/reordered; `sequence_gap`/`missing_genesis` = deleted rows.
2. Everything before that `chain_seq` is still proven intact; treat that row and everything
   after it as suspect.
3. Preserve evidence first: `pg_dump --table=operations.audit_events` plus the latest backup.
4. Treat it as a security incident, not an ops repair: rotate DB credentials, review
   connection logs, escalate. Do **not** recompute hashes — that destroys the evidence.
5. The alert closes automatically only after a verify cycle proves the chain clean again.

**Known limitations:** deleting the newest rows (truncation) is not detectable without
external anchoring/WORM offload; `emitSecurityAudit` is fail-open by design (watch for
`security_audit_insert_failed` in logs).

## Stuck Payment In Executing

**Detection:**

```sql
SELECT id, reference, status, created_at FROM payment.payments
WHERE status = 'Executing' AND created_at < now() - INTERVAL '2 minutes';
```

**Remediation:**

1. `GET /api/repair` — locate the payment and its job state (or `node scripts/repair.mjs list`).
2. Job dead-lettered or missing → `POST /api/repair/:id/retry` (or `node scripts/repair.mjs retry <id>`).
3. Job pending/running → wait for the worker; do not enqueue duplicates.
4. Retry returns 5xx → check downstream health:
   `curl http://127.0.0.1:4101/health` (wallet), `4105` (accounting), `4106` (reconciliation).
5. If the wallet debit already happened, the retry is idempotent — it resumes, not double-debits.

## Dead-Lettered Jobs

**Detection:**

```sql
SELECT id, type, tenant_id, attempts, last_error FROM platform.jobs WHERE status = 'dead_lettered';
```

**Remediation:**

1. Read `last_error` and identify the payment from the payload.
2. Restore the failing dependency (downstream service, provider, config).
3. `POST /api/repair/:paymentId/retry` to enqueue a fresh saga job.
4. Persistent dead-letter after 3 manual retries → escalate with the job rows and logs.

## Dead-Lettered Outbox Events

**Detection:**

```sql
-- Still retrying:
SELECT count(*) FROM platform.outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL;
-- Permanently failed after RELAY_MAX_RETRIES (default 5):
SELECT id, event_type, attempts, last_error, dead_lettered_at
FROM platform.outbox_events WHERE dead_lettered_at IS NOT NULL;
```

**Remediation:**

1. `curl http://127.0.0.1:9101/metrics` — check `deadLetterCount`, `unpublishedCount`, `outboxLagMs`.
2. Check consumer health (operations, reconciliation); fix the root cause named in `last_error`.
3. Restart the relay worker if it crashed (`npm run dev` manages it).
4. Re-queue a dead-lettered row manually by clearing `dead_lettered_at` and setting
   `attempts = 0` — there is no automated replay tool yet.
5. The watchdog raises "Outbox dead-letter queue non-empty" while rows remain dead-lettered.

## Provider Incident (Degraded Or Open Circuit)

**Signals:** provider status degraded in operations, circuit breaker open, saga submissions
failing with provider errors, policy `Provider route` check flagging degraded providers.

**Remediation:**

1. Identify the provider on `GET /api/state` → `providers`, or `GET /providers` on operations-service.
2. Confirm whether the outage is simulated/provider-side; check worker logs for the adapter error.
3. Route around it: the policy engine blocks payments through degraded providers; restore the
   provider (`POST /api/operations/providers/:id/toggle`) once healthy.
4. In-flight payments relying on the provider stay `Executing` on retryable failures, or fail
   cleanly with a recorded reason. Dead-lettered submissions are recovered via `GET /api/repair`.
5. Provider submission retries reuse the same idempotency key, so a recovered upload cannot
   duplicate a transfer.

## Demo Reset

- `POST /api/reset` (requires `admin:reset`) restores **the caller's tenant** to its seed
  baseline. Tenant 1 = Vega baseline, tenant 2 = Nordic baseline, unknown tenants = empty.
- In production mode reset returns `403 demo_reset_disabled` unless `ALLOW_DEMO_RESET=true`.
- `npm run smoke` calls this endpoint and restores the local demo baseline; run it only
  against disposable local data.

## DB Invariant Checks

```bash
npm run invariants   # exit 0 = clean; 1 = violation named in output
```

Covers negative balances, unbalanced ledger transactions, NULL-tenant jobs/outbox events,
and approvals integrity. Audit chain: `node scripts/verify-audit-chain.mjs`.

## Webhook Signature Failures

1. Verify the provider secret matches `operations.providers.webhook_secret` / `WEBHOOK_SECRET`.
2. Confirm the sender signs the exact raw body (HMAC-SHA256, hex, `x-webhook-signature`) —
   signatures over re-serialized JSON are rejected by design.
3. Rotate the secret on both sides if compromised; never accept unsigned payloads.

## Service Restart

1. Send `SIGTERM` to each process; workers finish in-flight jobs, the gateway drains.
2. Restart with `npm run dev` (or the container orchestrator).
3. Verify `/health`, `/ready`, and that relay/job workers are polling.

## Backup / Restore

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for `pg_dump`/`pg_restore` commands, PITR
requirements, and post-restore checks.
