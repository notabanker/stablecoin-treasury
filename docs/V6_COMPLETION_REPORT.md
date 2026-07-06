# V6 Completion Report — From Hardened Demo to Operable Pilot

Date: 2026-07-05
Test baseline: 125 tests (49 unit + 72 integration + 4 concurrency)

## Summary

V6 delivered eight epics transforming the platform from a hardened demo into a
pilot-operable treasury platform. The four headline deliverables are:

1. **Real four-eyes approvals** (Epic 1) — identity-tracked, append-only, creator-cannot-approve
2. **Database defense in depth** (Epic 2) — per-service Postgres roles + RLS on all 8 schemas
3. **Tamper-evident audit** (Epic 3) — SHA-256 hash chain with nightly verifier and runbook
4. **Provider adapter seam** (Epic 5) — custody adapter interface + simulated statement ingestion

Supporting epics added money-path observability (Epic 6), session hardening (Epic 4),
truth-in-docs (Epic 0), and deployment scaffolding (Task 7.1).

All 12 approved gates (A1–A6) have been exercised. Every epic was verified with the
full build-verify-harden loop including the live smoke test.

## Files Changed

See git diff for the complete delta. Major additions:

- **Migrations:** `0030` through `0047` (18 migrations) — csrf NOT NULL, payment_approvals,
  audit hash chain, service roles, RLS on 8 schemas, provider adapter columns, statement
  ingestion tables
- **New shared package:** `packages/shared/adapters/custody.mjs` (adapter interface +
  simulated adapter + circuit breaker)
- **New test files:** `log-hygiene.test.mjs`, `approvals.test.mjs`, `role-isolation.test.mjs`,
  `rls.test.mjs`, `audit-chain.test.mjs`, statement E2E tests
- **New scripts:** `verify-audit-chain.mjs`, `ingest-statement.mjs`
- **New infrastructure:** `infra/` Terraform skeleton, `.env.example.*` shape files
- **Documentation:** `PRODUCTION_READINESS.md` rewrite, ADR-010 (rate limiting),
  ADR-011 (OIDC), `RUNBOOKS.md` extended, `RELEASE_CHECKLIST.md` extended

## Per-Epic Fix Evidence

### Epic 0 — Truth Reconciliation and Carried Debt
- `PRODUCTION_READINESS.md` now lists every claim with its test reference
- CI proven green in GitHub Actions (badge in README)
- `csrf_token` is now `NOT NULL` at schema level (migration 0030)
- ADR-010 documents the in-memory rate limiter constraint

### Epic 1 — Real Four-Eyes Approvals
- `payment.payment_approvals` table with `UNIQUE(payment_id, approver_id)`
- `payments.created_by` tracks who created each payment
- HMAC-signed acting-user context propagates through the gateway → service-client
  → payment-service pipeline; tampered headers → 401
- Same approver twice → 409; creator self-approval → 403 (dev mode: skipped)
- Auto-approved payments write `approver_id = 'policy:auto'`
- DB invariant: `approval_rows_lt_count` must be 0

### Epic 2 — Database Defense in Depth
- 10 per-service Postgres roles with schema-scoped grants
- RLS on all 8 tenant-scoped schemas (migrations 0037–0044)
- `AsyncLocalStorage` tenant context in `db.mjs`; `current_setting(..., true)` fail-closed
- `wallet.wallet_balances` view with `security_invoker = true`
- Cross-tenant probes: WHERE-less SELECT returns zero rows, idempotency collision isolated,
  webhook processing tenant-scoped, audit reads tenant-scoped

### Epic 3 — Tamper-Evident Audit
- `operations.audit_events` with `row_hash`/`prev_hash` per tenant
- Canonical serialization in SQL only (single implementation)
- `pg_advisory_xact_lock` serializes concurrent inserts
- `scripts/verify-audit-chain.mjs` — detects row tampering, relinking, gap injection
- Nightly `audit-chain-verify` durable job with deduped alert

### Epic 4 — Session and Edge Hardening
- `__Host-` cookie prefix in secure mode
- Session rotation on login (old session destroyed)
- Idle timeout with grace window and absolute cap
- Logout clears cookies client-side (`Max-Age=0`)
- CSP: `default-src 'self'; frame-ancestors 'none'` + `X-Frame-Options: DENY`

### Epic 5 — Provider Adapter Seam + Reconciliation Ingestion
- `CustodyAdapter` interface; `SimulatedCustodyAdapter` (zero behavior change)
- Circuit breaker per provider (closed → open → half-open)
- `operations.providers` with `capabilities`, `environment`, `adapter` columns
- `reconciliation.provider_statements` + `statement_lines`
- Ingestion endpoint + matcher (exact ref match, heuristic, exception categories)
- E2E: settle → simulated statement emit → ingest → match

### Epic 6 — Money-Path Observability
- Relay/job/payment/gateway `/metrics` with outbox lag, DLQ size, payment state timing
- `ops-watchdog` durable job with alert dedup
- Log hygiene adversarial probe — zero credentials in captured logs

### Task 7.1 — Deployment Scaffolding
- Container hardening (healthcheck, read-only rootfs)
- CI image scan stage (Trivy)
- Per-environment env shape files (dev/staging/prod)
- Terraform skeleton under `infra/` — `terraform validate` passes; nothing provisioned

## Test Results

```
npm run check          — PASS (70+ files, known 0017 exception)
npm run test           — 49/49 pass (unit)
npm run test:integration — 72/72 pass (integration)
npm run test:concurrency — 4/4 pass
                       — 125/125 total
Production config gate — PASS
Live smoke             — PASS (reset cycle, settlement, outbox delivery)
```

## DB Invariants (all zero)

```
negative_balances      — 0
ledger_imbalances      — 0
jobs_without_tenant    — 0
outbox_without_tenant  — 0
approval_rows_lt_count — 0
verify-audit-chain.mjs — exit 0, chain intact
```

## Residual Risks

1. **Broad UPDATE/DELETE grants on append-only tables** persist because demo reset
   deletes in-band — needs owner-privileged reset path (backlog note).
2. **Production `SERVICE_DB_PASSWORD`** is the dev default in local env — the
   prod-config gate does not yet reject this (checklist item).
3. **OIDC/SSO** deferred to V7 (ADR-011) — pilot-blocking only if a partner mandates it.
4. **Task 5.3 (real sandbox rail)** is externally blocked on partner selection and
   a live secrets manager.
5. **All 12 external infrastructure items** are "Not started" — human-executed only.

## Go/No-Go

- **Demo:** GO
- **Investor diligence:** GO — four-eyes governance, tamper-evident audit,
  defense-in-depth roles+RLS, and self-alerting are proven and test-backed.
- **Production money movement:** NO-GO — external infrastructure items
  (Task 7.2 tracker) are human-executed and none have started. Task 5.3
  (sandbox certification) is externally blocked.
