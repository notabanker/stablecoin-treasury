# Technical Handoff For Follow-Up LLM

## Purpose

This document is a technical handoff for another implementation or audit LLM working on the Corporate Stablecoin Treasury Platform.

The codebase has made major progress and is demo/investor-diligence capable, but it is not yet production money-movement ready. The remaining work is concentrated around real-provider crash safety, tenant-complete operations, audit-chain reset semantics, and a few trust-boundary correctness issues.

Working directory:

```bash
/Users/notabanker/projects/corporate-stablecoin-treasury-platform
```

Treat the repository as actively changing. Some fixes may already be in progress. Before editing, inspect current files and do not blindly reapply stale patches.

## Ground Rules For The LLM

1. Do not revert unrelated local changes. The tree is dirty and may include work from other agents.
2. Prefer small, verifiable fixes over broad rewrites.
3. Add or update regression tests for every behavioral fix.
4. Preserve tenant isolation, RLS behavior, and service-role boundaries.
5. Do not weaken auth, CSRF, internal HMAC, idempotency, migration linting, or production config gates.
6. Do not introduce secrets into the repo or test output.
7. If a finding is already fixed, prove it with a targeted test and mark it verified.

## Last Observed Verification State

The following was observed during the audit pass before this handoff:

```bash
npm run check             # PASS
npm run test              # PASS, 49/49 unit tests
npm run test:integration  # FAIL, 71/72, audit-chain reset test failed with missing_genesis
npm run test:concurrency  # PASS, 4/4
npm run smoke             # PASS after starting npm run dev
```

Integration failure:

```text
tests/integration/audit-chain.test.mjs
audit chain stays valid across every insert path including demo reset
verifier returned:
{"ok":false,"checkedRows":7,"break":{"reason":"missing_genesis"}}
```

Current code already appears to include in-progress fixes for:

- `packages/shared/jobs.mjs`: `failJob` no longer double-increments attempts.
- `services/reconciliation-service/src/index.mjs`: statement ingestion now uses `enqueueJobInTx`.

These still need full verification because adjacent behavior may remain broken.

## Architecture Context

The platform is a local microservice simulation of a corporate stablecoin treasury system:

- API gateway: `services/api-gateway`
- Payment orchestration: `services/payment-service`
- Wallet and ledger: `services/wallet-service`
- Policy engine: `services/policy-service`
- Compliance: `services/compliance-service`
- Accounting: `services/accounting-service`
- Reconciliation: `services/reconciliation-service`
- Operations/audit/alerts/providers: `services/operations-service`
- Job worker: `services/job-worker`
- Relay worker/outbox dispatcher: `services/relay-worker`
- Shared platform utilities: `packages/shared`
- Schema migrations: `db/migrations`

Critical cross-cutting guarantees:

- Tenant isolation through explicit tenant IDs and Postgres RLS.
- Payment state-machine integrity.
- Wallet ledger must never create negative balances or unbalanced ledger transactions.
- Outbox/inbox should prevent silently dropped or duplicated side effects where consumers claim dedupe.
- Security audit chain should be tamper-evident and valid across all insert paths.
- Internal services should reject unsigned calls when `INTERNAL_AUTH_REQUIRED=true`.

## Finding 1: Provider Submission Is Still Not Crash-Safe

Severity: CRITICAL

Primary files:

- `services/job-worker/src/index.mjs`
- `packages/shared/adapters/custody.mjs`
- likely migration needed under `db/migrations`

Observed/current flow:

```text
executePaymentSaga
1. policy check
2. provider submitTransfer
3. persist provider_ref and chain_ref
4. wallet debit
5. accounting journal
6. reconciliation matched row
7. status Settled
```

The in-progress fix moved provider submission before ledger debit. That removes one old failure mode, but it does not make the external side effect crash-safe.

Remaining failure modes:

1. Worker calls provider.
2. Provider accepts the transfer.
3. Worker crashes before `payment.payments.provider_ref` is updated.
4. Retry sees no provider ref and calls provider again.
5. Real provider receives duplicate transfer.

Additional failure mode:

1. Provider accepts transfer and `provider_ref` is persisted.
2. Wallet debit fails afterward.
3. Code marks payment `Failed` even though the external transfer may already exist.
4. Internal ledger and external provider state diverge.

Required design:

- Introduce a durable provider-submission state before calling the provider.
- Use a deterministic provider idempotency key, preferably based on payment ID or immutable payment reference.
- Pass that idempotency key into `adapter.submitTransfer`.
- Persist enough information before the external call to make retry behavior deterministic.
- On retry, if local submission state exists but `provider_ref` is missing, do not blindly resubmit. Reconcile by provider idempotency key or call provider status lookup.
- If provider accepted but downstream internal steps fail, payment must not be marked simply `Failed` without a repair/reconciliation path. Use a distinct state such as `ProviderSubmitted`, `SettlementPending`, or keep `Executing` with a repairable step marker.
- Wallet ledger should model reservation/hold versus final debit, or have a compensating reversal path that is provably balanced.

Minimum acceptable implementation options:

Option A:

- Add `payment.provider_submissions` table with:
  - `tenant_id`
  - `payment_id`
  - `provider_id`
  - `idempotency_key`
  - `status`
  - `provider_ref`
  - `chain_ref`
  - `last_error`
  - timestamps
  - unique `(tenant_id, payment_id)`
  - unique `(tenant_id, provider_id, idempotency_key)`
- Insert or lock this row before external call.
- Submit using the deterministic idempotency key.
- Persist provider refs immediately after accepted response.
- Resume from this row on retry.

Option B:

- Add provider submission columns to `payment.payments` if a separate table is too much:
  - `provider_submission_idempotency_key`
  - `provider_submission_status`
  - `provider_submission_attempted_at`
  - `provider_submission_last_error`
- This is less clean but acceptable if thoroughly tested.

Required tests:

1. Fake adapter accepts transfer, then process crashes or throws before provider ref persistence. Retrying must not call `submitTransfer` twice.
2. Fake adapter records submitted idempotency keys. Same payment retry must reuse same key.
3. Provider accepted, wallet debit fails. Payment must land in a repairable/reconcilable state, not terminal `Failed` with external state lost.
4. Retry after provider accepted and wallet debit fixed must settle exactly once.
5. DB invariants remain clean:

```sql
SELECT COUNT(*) FROM wallet.balances WHERE balance < 0;
SELECT transaction_id FROM wallet.ledger_entries GROUP BY transaction_id HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) <> 0;
```

Acceptance criteria:

- No scenario can cause duplicate external transfer for one payment.
- No scenario can hide an accepted external transfer behind a plain `Failed` payment.
- Provider submission attempts are observable in DB or audit.

## Finding 2: Job Attempt Accounting Fix Needs Verification And Metrics Cleanup

Severity: HIGH

Primary files:

- `packages/shared/jobs.mjs`
- `services/job-worker/src/index.mjs`
- tests under `tests/integration` or `tests/unit`

Original bug:

- `claimJobs` incremented `attempts`.
- `failJob` incremented again.
- Jobs dead-lettered early and attempts metadata lied.

Current in-progress state:

- `packages/shared/jobs.mjs` appears fixed: `failJob` uses `job.attempts` as the current attempt number.

Remaining issue:

- `services/job-worker/src/index.mjs` still appears to use `if (job.attempts + 1 >= job.max_attempts)` for `metrics.deadLettered`.
- That metric should match the real dead-letter transition, likely `job.attempts >= job.max_attempts` after claim.

Required tests:

1. Create a job with `max_attempts=3` and a handler that always fails.
2. Assert exactly three started attempts are recorded.
3. Assert the job dead-letters only on the third actual execution.
4. Assert `platform.jobs.attempts = 3`.
5. Assert worker `deadLettered` metric increments on the same execution that sets DB status to `dead_lettered`.

Acceptance criteria:

- No off-by-one in job attempts.
- Metrics and DB state agree.
- Existing dead-letter alert outbox behavior still works.

## Finding 3: Audit Chain Reset Race

Severity: HIGH

Primary files:

- `services/api-gateway/src/index.mjs`
- `services/operations-service/src/seed.mjs`
- `packages/shared/audit.mjs`
- `services/relay-worker/src/index.mjs`
- `tests/integration/audit-chain.test.mjs`

Observed failure:

`npm run test:integration` failed in `audit-chain.test.mjs` with `missing_genesis` after demo reset.

Current risky behavior:

- Gateway reset fans out service resets concurrently.
- Operations reset deletes tenant-1 audit rows and reseeds the chain.
- Relay can still deliver old outbox audit events from before reset.
- A pre-reset event can append into the new chain or cause chain sequence discontinuity.

Required design decision:

Choose one of these approaches and document it.

Option A: Reset is a destructive demo-only operation

- Quiesce or drain relay/job activity before reset.
- Delete or mark processed tenant-scoped platform outbox/inbox/jobs that can deliver stale audit events.
- Reset operations audit under the same per-tenant advisory lock used by chained insert.
- Ensure no old outbox event can append to the newly seeded chain.

Option B: Audit chains are never deleted

- Stop deleting `operations.audit_events` in reset.
- Append an explicit `Demo reset` event.
- Reseed providers/alerts only.
- UI can filter/reset demo view, but audit remains append-only.

Option C: Chain generations

- Add audit chain generation/epoch.
- Reset starts a new generation cleanly.
- Verifier validates `(tenant_id, generation)` chains.

Recommended:

- For production-grade audit semantics, choose Option B.
- If demo reset must wipe visible history, choose Option C.
- Option A is acceptable only if reset remains explicitly non-production.

Required tests:

1. Existing `audit-chain.test.mjs` must pass.
2. Create payment to generate outbox audit event, immediately call reset, then wait for relay. Verifier must remain clean.
3. Run reset repeatedly under relay activity. Verifier must remain clean.
4. `scripts/verify-audit-chain.mjs` must exit 0 after reset and post-reset audit append.

Acceptance criteria:

- Reset cannot produce `missing_genesis`, `sequence_gap`, `prev_hash_mismatch`, or `row_hash_mismatch`.
- Behavior is documented in `docs/RUNBOOKS.md`.

## Finding 4: Provider Statement Idempotency Is Not Tenant-Scoped

Severity: HIGH

Primary file:

- `db/migrations/0047_provider_statements.sql`

Current schema:

```sql
UNIQUE (provider_id, external_id)
```

Bug:

Two tenants can receive valid statements from the same provider with the same external ID. The second tenant receives a false duplicate.

Required fix:

- Change uniqueness to:

```sql
UNIQUE (tenant_id, provider_id, external_id)
```

Important migration note:

- If migration `0047` is already applied in dev/test DBs, do not edit only the old migration and call it done.
- Add a new migration that drops the old unique constraint/index and creates the tenant-scoped one.
- If the project policy allows rewriting unapplied migrations only, confirm with migration state first.

Required tests:

1. Tenant 1 ingests `(providerId=prov-x, externalId=stmt-1)`.
2. Tenant 2 ingests the same `(providerId=prov-x, externalId=stmt-1)`.
3. Both succeed and create separate statement rows.
4. Tenant 1 replays the same statement again and gets duplicate/no-op.
5. Tenant 2 replays the same statement again and gets duplicate/no-op.

Acceptance criteria:

- Idempotency is per tenant.
- RLS tests still pass.

## Finding 5: Watchdog And Auto-Expiry Only Cover Default Tenant

Severity: HIGH

Primary file:

- `services/job-worker/src/index.mjs`

Current risky behavior:

- `payment-auto-expiry` updates only `DEFAULT_TENANT_ID`.
- `ops-watchdog` calls `runWatchdog(DEFAULT_TENANT_ID)`.

Bug:

Tenant 2+ pending approvals, stuck executions, outbox lag, dead-letter jobs, and audit-chain issues can go unreported.

Required fix:

- Add a tenant enumeration helper, using `identity.tenants` or a platform-safe source.
- Run expiry and watchdog checks for every active tenant.
- Ensure service role grants allow this safely.
- Avoid emitting one cross-tenant alert under the default tenant for another tenant's problem.

Required tests:

1. Create stale pending approval payment in tenant 2. Auto-expiry must cancel it.
2. Create stuck executing payment in tenant 2. Watchdog must open tenant-2 alert.
3. Create tenant-2 unpublished outbox lag. Watchdog must open tenant-2 alert.
4. Ensure tenant 1 state/audit/alerts do not show tenant-2 alerts.

Acceptance criteria:

- All background operational checks are tenant-complete.
- Alerts are tenant-scoped.

## Finding 6: Internal Auth Header Parse Can Throw Before Auth Rejection

Severity: MEDIUM

Primary file:

- `packages/shared/http.mjs`

Risky behavior:

- `X-Acting-User` is parsed with `JSON.parse` while constructing context.
- This happens before `validateInternalAuth` rejects unsigned or invalid requests.
- Malformed JSON can produce a 500 instead of a controlled 401/400.

Required fix:

- Do not parse `X-Acting-User` before signature validation in internal-auth mode.
- Treat malformed acting-user JSON as:
  - `401 internal_auth_required` if auth is required and signature invalid.
  - `400 invalid_acting_user` if signature is valid but JSON is malformed.
- In dev mode, malformed header should also return controlled `400`, not crash.

Required tests:

1. `INTERNAL_AUTH_REQUIRED=true`, unsigned request with malformed `X-Acting-User` returns 401, not 500.
2. Signed request with malformed `X-Acting-User` returns 400, not 500.
3. Valid signed request still passes and exposes `context.actingUser`.

Acceptance criteria:

- No malformed header can crash an internal endpoint.

## Finding 7: Webhook Signature Verification Uses Parsed JSON, Not Raw Body

Severity: HIGH for real provider integration, MEDIUM for demo

Primary files:

- `services/api-gateway/src/webhooks.mjs`
- `packages/shared/http.mjs`
- `services/api-gateway/src/index.mjs`

Current behavior:

- HMAC is computed over `JSON.stringify(payload)`.
- Real providers commonly sign exact raw request bytes.
- JSON parse/stringify changes whitespace, key order, and formatting.

Required fix:

- Preserve raw request body for webhook routes.
- Verify signature over raw bytes/string exactly as received.
- Only parse JSON after signature validation where practical.
- Add timestamp header/freshness validation if the provider contract supports it.
- Reject replayed stale timestamps.

Required tests:

1. Payload with whitespace/key order signed as raw body is accepted.
2. Same semantic JSON with different raw bytes fails unless separately signed.
3. Missing timestamp is rejected in production mode if timestamp requirement is enabled.
4. Stale timestamp is rejected.
5. Existing valid demo webhook tests still pass.

Acceptance criteria:

- Signature behavior matches real provider contracts and is documented.

## Finding 8: Relay Claims Are At-Least-Once, But Comments/Expectations Drift Toward Exactly-Once

Severity: MEDIUM

Primary file:

- `services/relay-worker/src/index.mjs`

Current behavior:

- Relay selects unpublished events with `FOR UPDATE SKIP LOCKED`.
- It commits the transaction before HTTP delivery.
- While delivery is in progress, another relay instance can select the same event because `published_at` is still null.
- Consumers with inbox dedupe handle duplicates; consumers without it may not.

Required fix options:

Option A:

- Keep at-least-once semantics and document it clearly.
- Ensure every non-idempotent consumer uses inbox dedupe.
- Add tests with two relay workers delivering the same event.

Option B:

- Add `claimed_at`, `claimed_by`, `claim_expires_at`.
- Relay claims events durably, delivers, then marks published.
- Expired claims are retryable.

Required tests:

1. Two relay workers cannot cause duplicate side effect for audit/alerts/reconciliation.
2. Relay crash after claim but before delivery eventually retries.
3. Unknown event route behavior is explicit: either dead-letter/alert or mark published with operator-visible metric.

Acceptance criteria:

- Semantics are honest and safe for all consumers.

## Finding 9: Cancel Audit Actor Is Hard-Coded

Severity: MEDIUM

Primary file:

- `services/payment-service/src/index.mjs`

Bug:

- Cancel audit payload hard-codes actor `"Marta Klein"`.
- This corrupts audit attribution.

Required fix:

- Pass verified acting user from gateway to payment service.
- Use `context.actingUser.display` or stable user ID/email.
- Fall back to `System` only for system-initiated cancellation.

Required tests:

1. User A cancels payment; audit actor is User A.
2. User B cancels payment; audit actor is User B.
3. System cancellation uses `System`, not Marta.

Acceptance criteria:

- Audit actor reflects the real authenticated principal.

## Finding 10: Wallet Ledger Idempotency Lacks Request Hash

Severity: MEDIUM

Primary file:

- `services/wallet-service/src/ledger.mjs`

Current behavior:

- Reusing `(tenant_id, idempotency_key)` returns the existing transaction.
- It does not verify that the new request body matches the original request body.

Risk:

- A caller can reuse an idempotency key with different wallet/amount/payment data and receive a successful old transaction.
- Current payment path uses deterministic `debit:${payment.id}`, which limits exposure, but the wallet service contract is unsafe.

Required fix:

- Store request hash on `wallet.ledger_transactions` or a companion idempotency table.
- On replay:
  - same hash returns original transaction.
  - different hash returns `409 idempotency_key_reuse`.

Required tests:

1. Same idempotency key and same body returns original transaction.
2. Same idempotency key and different amount returns 409.
3. Same idempotency key and different wallet returns 409.

Acceptance criteria:

- Wallet service idempotency matches payment service semantics.

## Finding 11: Audit Insert Mutates Transaction Tenant Context

Severity: MEDIUM

Primary file:

- `packages/shared/audit.mjs`

Risky behavior:

- `insertAuditEventChained` calls `set_config('app.tenant_id', eventTenant, true)` on the caller's transaction.
- It does not restore the prior transaction tenant context.
- If caller does additional tenant-scoped work after audit insert, it can run under the audit event tenant.

Required fix options:

Option A:

- Require audit insert to happen last in every transaction and document/enforce with helper names.

Option B:

- Capture previous `current_setting('app.tenant_id', true)`, set audit tenant, insert, then restore previous tenant before returning.

Recommended:

- Implement Option B unless there is a Postgres/RLS reason not to.

Required tests:

1. In a transaction under tenant 1, insert tenant-2 audit event, then perform tenant-scoped tenant-1 write/read. It must still use tenant 1.
2. Existing tenant-scoped failed-login audit tests still pass.

Acceptance criteria:

- Audit insert cannot leak tenant context into caller work.

## Finding 12: Production Infra Is Still A Skeleton

Severity: HIGH for production readiness

Primary files:

- `infra/main.tf`
- `infra/modules/*/main.tf`
- `infra/README.md`

Observed state:

- Top-level Terraform declares desired modules.
- Module `main.tf` files were empty during audit.
- README correctly says nothing is provisioned.

Required action:

- Do not claim production infrastructure is implemented.
- Either build actual Terraform modules or keep docs explicit that infra is a skeleton.
- Production money movement requires:
  - managed Postgres with PITR
  - secrets manager
  - WAF/rate limiting at ingress
  - TLS termination
  - private service networking
  - monitoring/alerting
  - backup/restore drill
  - deployment rollback path
  - mTLS or equivalent service identity if required

Acceptance criteria:

- Docs and readiness claims match reality.
- CI does not imply infra is productionized if it is not.

## Verification Loop

The implementation LLM must run this loop after fixes.

### 1. Baseline

```bash
git status --short
npm run check
npm run test
```

Record any pre-existing failures before editing.

### 2. Targeted Regression Tests

Add tests for each touched finding:

```bash
node --test tests/unit/*.test.mjs
node --test --test-concurrency=1 tests/integration/audit-chain.test.mjs
node --test --test-concurrency=1 tests/integration/statements.test.mjs
node --test --test-concurrency=1 tests/integration/saga.test.mjs
node --test tests/concurrency/*.test.mjs
```

Add new focused tests if existing files are not the right home.

### 3. Full Suite

```bash
npm run check
npm run test
npm run test:integration
npm run test:concurrency
```

### 4. Smoke

```bash
npm run dev
npm run smoke
```

Stop the dev stack cleanly afterward.

### 5. DB Invariants

Run these against the test/dev DB used for smoke:

```sql
SELECT COUNT(*) AS negative_balances
FROM wallet.balances
WHERE balance < 0;

SELECT transaction_id
FROM wallet.ledger_entries
GROUP BY transaction_id
HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0;

SELECT COUNT(*) AS jobs_without_tenant
FROM platform.jobs
WHERE tenant_id IS NULL;

SELECT COUNT(*) AS outbox_without_tenant
FROM platform.outbox_events
WHERE tenant_id IS NULL;

SELECT COUNT(*) AS statement_tenant_mismatches
FROM reconciliation.statement_lines l
JOIN reconciliation.provider_statements s ON s.id = l.statement_id
WHERE l.tenant_id <> s.tenant_id;
```

All counts must be zero.

### 6. Audit Chain

```bash
node scripts/verify-audit-chain.mjs
```

Expected:

```json
{"ok":true}
```

The exact `checkedRows` may vary.

### 7. Production Config Probe

Run the production config check with safe dummy values only. Do not use real secrets.

```bash
PRODUCTION_MODE=true \
NODE_ENV=production \
AUTH_REQUIRED=true \
INTERNAL_AUTH_REQUIRED=true \
INTERNAL_SERVICE_TOKEN=dummy-prod-token-with-enough-length \
SESSION_COOKIE_SECURE=true \
CORS_ORIGIN=https://example.invalid \
DATABASE_URL=postgres://user:pass@db.example.invalid:5432/treasury \
DEMO_SEED_ENABLED=false \
npm run check
```

Expected: config gate passes or fails only for intentionally missing required values. It must not print secret values.

## Required Completion Report

When finished, produce a report with:

1. Files changed.
2. Migrations added or modified.
3. Tests added.
4. Exact commands run and pass/fail output summary.
5. DB invariant results.
6. Any residual risks.
7. Updated go/no-go:
   - Demo
   - Investor diligence
   - Production money movement

## Go/No-Go Guidance

Current target state after all above fixes:

- Demo: GO
- Investor diligence: GO if the report includes residual infra limitations
- Production money movement: still NO-GO unless real provider integrations, secrets management, managed Postgres/PITR, ingress protection, and deployment operations are also implemented and tested

The application code can become production-grade before the infrastructure is productionized. Do not conflate those two claims.
