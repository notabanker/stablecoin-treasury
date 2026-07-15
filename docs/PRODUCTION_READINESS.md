# Production Readiness

Last updated: 2026-07-15 (V8). This document is the single source of truth for
what is delivered and what is still required before real money movement. Every
"delivered" claim carries a test or probe reference; nothing is listed as missing
that already exists.

## Test Suite

| Suite | Command | Count | Scope |
|---|---|---|---|
| Unit | `npm run test` | 55 | Pure logic, no DB access at import time |
| Integration | `npm run test:integration` | 92 | Full stack against ephemeral throwaway databases, sequential execution |
| Concurrency | `npm run test:concurrency` | 4 | N-way parallel requests against a live stack |
| Smoke | `npm run smoke` | — | Happy path + 4 failure paths against local loopback |
| **Total** | `npm run test:all` | **151** | |

---

## Delivered Capabilities

### Foundation (M0)

- ESM-only project (`"type": "module"`), Node >= 20, zero runtime dependencies except `pg`.
- Schema-per-service Postgres: `wallet`, `payment`, `policy`, `compliance`, `accounting`,
  `reconciliation`, `operations`, `platform`, `identity` — each with its own namespace.
- Docker Compose: Postgres 16 with persistent volume and healthcheck, `db-migrate` one-shot
  job with service dependency ordering, non-root container runtime, only gateway port published.
- Migration check: `scripts/check-migrations.mjs` rejects duplicate migration prefixes.
  Verified by: `npm run check`.

### Double-Entry Ledger (M2)

- `wallet.ledger_transactions` + `wallet.ledger_entries` with `direction` (`credit`/`debit`).
- Deferred constraint trigger `reject_unbalanced_ledger` at commit time — an unbalanced batch
  is rejected by the database, not the application.
- Wallet balances derive from ledger entries (balance = SUM(credit) - SUM(debit)).
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — settlement produces exactly 3
    balanced journal entries (total debits = total credits = amount + fee).
  - **Test:** `tests/unit/accounting-journals.test.mjs` — `createPaymentJournals` produces
    balanced entries; supplier payables and intercompany receivables are correctly labeled;
    `assertBalanced` rejects unbalanced entries; NaN/zero/negative amounts rejected.
- Non-negative wallet balance constraint: `wallet.wallet_balances.balance >= 0` CHECK.
  - **Test:** `tests/integration/payment-idempotency-db.test.mjs` — 10 concurrent 20-unit
    debits against a 100-unit balance: exactly 5 succeed, balance is exactly 0 (no overdraft).
  - **DB invariant:** `SELECT COUNT(*) FROM wallet.wallet_balances WHERE balance < 0` → 0.

### Payment State Machine (M2)

- `payment.payments.status` with CHECK constraint; `payment.payment_events` transition log.
- Valid transitions enforced at the database level: `null → Pending approval → Approved →
  Executing → Settled`; terminating states (`Settled`, `Cancelled`, `Failed`, `Blocked`)
  cannot transition further.
  - **Test:** `tests/integration/payment-transitions-db.test.mjs` — skip-state rejected
    (e.g. `Pending approval` → `Settled` throws "Invalid payment status transition"),
    resurrection rejected (`Cancelled` → `Approved`), same-status updates do not create
    spurious transition events.
- Unique payment references via sequence `payment.payment_reference_seq`.
  - **Test:** `tests/concurrency/payment-races.test.mjs` — 25 concurrent creates with
    distinct keys all produce unique references.
  - **Test:** `tests/integration/payment-idempotency-db.test.mjs` — 30 concurrent
    `allocateReference` calls all return unique references.

### Transactional Outbox, Saga, and Durable Jobs (M3)

- `platform.outbox_events`: events written inside the same transaction as the domain write
  that produced them; relay-worker polls and delivers them to internal service endpoints.
  - **Test:** `tests/integration/saga-failure.test.mjs` — outbox events survive relay-worker
    restart (events are in the DB, not an in-memory queue).
- `platform.inbox_events`: consumer deduplication by `(eventId, service)` — redelivery of
  the same outbox event produces exactly one side effect.
  - **Test:** `tests/integration/saga.test.mjs` — outbox events delivered twice produce
    exactly one alert, one audit event, and one reconciliation row.
- `platform.jobs`: durable jobs with `run_at` rescheduling, `status` tracking, and
  `handler` routing. Payment execution runs as a saga via the job worker.
  - Saga steps: policy check → ledger debit → provider submission → reconciliation match.
  - **Test:** `tests/integration/saga.test.mjs` — execution attempt records include
    `policy_check`, `ledger_debit`, `settlement` steps; execution-time policy violations
    transition to `Failed` (not stuck in `Executing`).
- Saga idempotency: re-executing while `Executing` does not enqueue a second job;
  re-executing after `Settled` returns `"Already settled"`.
  - **Test:** `tests/integration/saga.test.mjs` — exactly one job, one wallet debit.
- Resumable execution: `GET /api/repair` lists stuck payments; `POST /api/repair/:id/retry`
  re-enqueues an `Executing` payment.
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — resuming from `Executing`
    does not double-debit (wallet balance identical after first and second execute).
  - **Test:** `tests/concurrency/payment-races.test.mjs` — 10 concurrent `execute` calls
    on the same payment: at least one succeeds, wallet debited exactly once (FOR UPDATE
    prevents concurrent double-debit).

### Tenant Isolation (M2–M4)

- Every table carries a `tenant_id` from its first migration. Application queries scope by
  `tenant_id` from the verified request context.
- API-layer enforcement: cross-tenant access returns 404.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — tenant 1 sees only its own wallets
    (not tenant 2's), tenant 2 sees only its own wallets (not tenant 1's), cross-tenant
    payment creation returns 404, cross-tenant approval returns 404.
- Tenant-scoped audit: login failure for a known tenant-2 email writes the audit event
  under tenant 2; unknown email falls back to the default platform tenant (documented).
  - **Test:** `tests/integration/auth-rbac.test.mjs` — failed login audit scoped to
    correct tenant; lockout audit scoped to correct tenant; unknown email audit under
    default platform tenant.
- Idempotency-key scope: tenant-scoped by `(tenant_id, idempotency_key)` unique constraint.
  - **Test:** `tests/concurrency/payment-races.test.mjs` — 50 concurrent creates with
    identical idempotency key produce exactly 1 payment.

### Authentication and Session Security (M4, V5.1)

- Email + password authentication with salted scrypt (`scrypt$16384$8$1$`).
  - **Test:** `tests/unit/auth.test.mjs` — scrypt hashing produces distinct salts per call;
    verifyPassword correctly validates and rejects; legacy SHA-256 hashes verify and flag
    rehash needed.
- Session cookies: `HttpOnly`, `Secure` (when `SESSION_COOKIE_SECURE=true`), `SameSite=Strict`,
  `Path=/`, no `Domain` attribute.
- Emails are unique per `(tenant_id, email)` — cross-tenant duplicate-email login works.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — tenant-2 login with email that exists
    in tenant 1 resolves correctly (password decides the match in `authenticateUser`).

### CSRF Protection (M4, V5.1)

- Double-submit cookie pattern: `X-Csrf-Token` header must match the readable `csrf` cookie.
  - **Test:** `tests/unit/auth.test.mjs` — `verifyCsrf` rejects wrong, empty, or missing
    tokens; CSRF skipped for bearer-authenticated requests.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — `POST /api/logout` without
    `X-Csrf-Token` returns 403 `csrf_invalid`; with correct token returns 200.
- Null-CSRF session blocking: directly nullifying `csrf_token` in the database for an
  active session → subsequent mutation returns 403 `csrf_invalid`.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — nullified session cannot mutate.
  - Runtime strictness covers the schema-level gap (csrf_token remains nullable at
    the schema until Task 0.2 / gate A4).
- CSRF header is mandatory for cookie-based mutating requests: `x-csrf-token` is in
  `Access-Control-Allow-Headers`.
- Backend-generated CSRF token on login; never exposed in server responses beyond the
  Set-Cookie header.

### Role-Based Access Control (M4)

- Permissions checked per route: `payment:create`, `payment:approve`, `policy:update`,
  `operations:reset`, `wallet:read`, `reconciliation:read`.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — admin (`marta@vega-industries.com`)
    can create payments (has `payment:create`); approver role cannot create payments (403),
    cannot update policies (403), cannot reset state (403); anonymous requests to mutating
    routes return 401.
- Seeded roles: `admin` (full access), `approver` / `treasury-manager` / `analyst`
  (limited).
- Dev mode (`AUTH_REQUIRED=false`): system identity with all permissions; keeps demos
  functional without authentication setup.

### Rate Limiting and Brute-Force Protection (V5.1)

- Per-IP sliding-window token-bucket rate limiter on the gateway.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — with `TRUST_PROXY_HEADERS=true`,
    different `X-Forwarded-For` IPs get separate buckets (3 requests from 3 IPs all pass);
    with `TRUST_PROXY_HEADERS` disabled, spoofed `X-Forwarded-For` does not bypass rate
    limit (3rd request gets 429).
- Login brute-force lockout per `(ip, email)`: configurable max attempts, lockout window,
  auto-reset on lockout expiry.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — with `LOGIN_RATE_LIMIT_MAX=2`,
    third failed login for a tenant-2 email triggers lockout; lockout audit event scoped
    to correct tenant.
- **Constraint:** rate limiters and login lockout are in-memory `Map` per process (not
  shared across replicas). Acceptable for single-instance pilot; requires Redis or
  equivalent when horizontal scaling is introduced (ADR-010). See `docs/ENVIRONMENT.md`
  for the documented constraint.

### Internal Service Authentication (M4, V5.1)

- HMAC-signed internal requests: `signInternalRequest` / `validateInternalAuth` in
  `packages/shared/http.mjs`. Gateway signs requests to domain services; domain services
  verify the signature before processing.
  - **Test:** `tests/integration/auth-rbac.test.mjs` — when `INTERNAL_AUTH_REQUIRED=true`,
    unsigned direct calls to wallet and payment services return 401; gateway-mediated
    requests succeed because the service-client signs them.
- All services capable of HMAC auth: api-gateway, wallet, policy, compliance, payment,
  accounting, reconciliation, operations.

### Webhook Signature Verification (M4)

- HMAC-SHA256 webhook signatures: `X-Signature` header validated against `WEBHOOK_SECRET`
  per provider configuration.
  - **Test:** `tests/integration/webhooks.test.mjs` — invalid signature returns 401
    `invalid_signature`; valid signature after a previous invalid attempt succeeds (no
    state corruption); duplicate `eventId` returns `"duplicate"`; same `eventId` to
    different providers both return `"processed"` (dedup is provider-scoped).

### Production Boot Gate (V5.1)

- `validateProductionConfig()` enforces minimum production requirements on startup:
  `AUTH_REQUIRED=true`, `INTERNAL_SERVICE_TOKEN` set and not default, `DATABASE_URL`
  not localhost, `CORS_ORIGIN` set and not wildcard.
  - **Test:** `tests/unit/config.test.mjs` — 8 cases: production mode fails on each
    missing/wrong setting; production mode passes with safe dummy config; error messages
    never leak raw secret values.

### Payment Lifecycle Controls (M5)

- Counterparty gating: blocked counterparty → payment `Blocked` on creation,
  approval returns 409; counterparty under review → approval returns 409 `review_required`.
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — blocked counterparty
    blocked; review counterparty blocks approval.
- Hard transfer limits: payments over the EUR-converted hard limit are `Blocked`.
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — 750,000 EUR payment
    blocked even with sufficient balance.
  - **Test:** `tests/unit/policy-evaluate.test.mjs` — non-EUR assets converted before
    limit comparison; `requiredApprovalsFor` boundary values correct.
- Policy engine: asset allowlist, provider allowlist with degradation states,
  counterparty status gating, concentration checks, screening toggle.
  - **Test:** `tests/unit/policy-evaluate.test.mjs` — 11 evaluation scenarios; 5
    policy validation tests (negative thresholds, threshold ordering, concentration
    range, hard limit positivity).
- Idempotency: replay with same key returns the original payment; reuse with different
  body returns 422 `idempotency_key_reuse`.
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — replay returns 200,
    reuse returns 422.
  - **Test:** `tests/integration/payment-idempotency-db.test.mjs` — reserve/reserve
    (pending)/hash-mismatch/complete/release lifecycle; 15-way concurrent reservation
    serialization.
- Wallet debit input validation: NaN, zero, and negative amounts rejected.
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — 422 for each.
- Intra-group transfers: destination wallet gains exactly the principal (no money lost).
  - **Test:** `tests/integration/payment-lifecycle.test.mjs` — source loses amount + fee,
    destination gains amount.

### Security Audit

- `operations.audit_events`: append-only (`REVOKE UPDATE, DELETE`). Records
  login/logout, payment lifecycle events, RBAC decisions, lockout events.
  - Tenant-scoped: audit rows are written under the correct tenant.
    **Test:** `tests/integration/auth-rbac.test.mjs` — tenant-scoped audit writes.
  - **Note:** audit rows are not yet tamper-evident (no hash chain). See Gap G3 /
    Epic 3.

### Observability Endpoints

- Every service exposes: `/health` (DB connectivity), `/ready` (DB + liveness),
  `/metrics` (request counters, status code distribution, duration).
- Gateway serves the frontend: `/` → `apps/web/index.html`, `/main.js` →
  `apps/web/main.js`, `/styles.css` → `apps/web/styles.css`.
  - **Note:** metrics are HTTP counters only (no money-path metrics). See Gap G9 /
    Epic 6.

### Container and Dev Infrastructure

- Docker Compose with 10 services ([refer to docker-compose.yml for details](file://docker-compose.yml)): health checks,
  restart policies, non-root runtime, gateway-only exposure.
- `npm run dev` runs all services as local child processes with automatic port
  allocation for parallel test databases.
  - **Test:** `tests/helpers/stack.mjs` — boots all 10 services on probed free ports
    with a fresh migrated throwaway database, dropped on `stop()`.

---

## Verified Gaps (V6 Planning)

These gaps were confirmed by direct code inspection on 2026-07-04. Each maps to
a V6 epic (see `docs/V6_PLAN.md` for rationale and `docs/V6_TASK_LIST.md` for
the detailed task breakdown).

| # | Gap | V6 Epic | Gate |
|---|---|---|---|
| G1 | Approvals are an anonymous counter — no approver identity, no `payment_approvals` table, creator can approve own payments, one user can supply both required approvals | Epic 1 | A1 |
| G2 | No per-service Postgres roles, no RLS policies — every service role can read every schema | Epic 2 | A2 |
| G3 | Audit rows are append-only (REVOKE) but not tamper-evident — no hash chain | Epic 3 | A3 |
| G4 | `identity.sessions.csrf_token` nullable at schema level (runtime-remediated in V5.1) | Task 0.2 | A4 |
| G5 | Rate limiters and login lockout are in-memory per process — reset on restart, not shared across replicas | Task 0.3 (ADR) | — |
| G6 | No OIDC/SSO — local email+password only | Task 4.3 (decision) | A6 |
| G7 | Provider execution is simulated — no adapter interface, no sandbox/prod separation | Epic 5 | A5 |
| G8 | No reconciliation statement ingestion — recon rows derive from our own payment events only | Epic 5 | A5 |
| G9 | Observability is per-service `/metrics` counters only — no money-path metrics (outbox lag, DLQ size, stuck payments), no alert rules, no trace propagation | Epic 6 | — |
| G10 | No IaC, secrets manager, WAF, managed Postgres/PITR, mTLS — the entire infrastructure phase | Epic 7 | A6 |
| G11 | This document was stale — listed ledger/saga/RBAC as "still required" (fixed by this rewrite) | Task 0.1 | — |
| G12 | CI workflow never proven in GitHub Actions | Task 0.4 | — |

---

## Still Required Before Real Money

The items below are genuinely not yet delivered. Each carries the V6 epic that
will address it.

### Application Governance (V6)

- Real four-eyes approvals with verified approver identity, creator-cannot-approve,
  and distinct approvers (Epic 1).
- Tamper-evident audit chain with nightly verification and runbook (Epic 3).
- OIDC/SSO — decision recorded (Epic 4.3); implementation pending partner requirement.

### Database Defense in Depth (V6)

- Per-service Postgres roles with cross-schema `REVOKE` (Epic 2).
- Row-level security on tenant-scoped tables (Epic 2).
- `csrf_token` NOT NULL at schema level (Task 0.2).

### Provider Integration (V6)

- Custody adapter interface with circuit breaker; sandbox/prod provider separation (Epic 5).
- Provider statement ingestion and matching (Epic 5).
- First real sandbox rail — blocked on partner selection and a secrets manager (Task 5.3).

### Observability and Alerting (V6)

- Money-path metrics: outbox lag, DLQ size, stuck payments, saga step failures (Epic 6).
- Internal watchdog and alert loop with runbook (Epic 6).
- Log hygiene enforcement (no secrets in logs) (Epic 6).

### Infrastructure (Human-Executed)

These items require cloud accounts and operational decisions. They are tracked in
Epic 7 (Task 7.2) but are explicitly **not implementable by code agents**.

- Secrets manager selection and provisioning.
- Managed Postgres with PITR, backups, and restore drills.
- WAF/DDoS protection.
- mTLS or private networking between services.
- Centralized logs, metrics, and alert routing.
- Environment promotion pipeline (dev → staging → prod).
- On-call and incident response procedures.

### Legal and Compliance

- DORA/ICT risk assessment.
- Jurisdictional review for the chosen provider and custodian.
- PSP/CASP licensing as applicable.
- User acceptance and operational readiness testing with treasury team.

---

## Operational Commands

```bash
npm run db:setup          # one-time: create treasury_dev/treasury_test, apply migrations
npm run check             # syntax check every .mjs file + apps/web/main.js + migration check
npm run dev               # start all 10 services against DATABASE_URL (defaults to treasury_dev)
npm run test              # unit tests (55 tests, pure logic, no DB required)
npm run test:integration  # integration tests (92 tests, full stack against ephemeral DBs)
npm run test:concurrency  # concurrency tests (4 tests, N-way parallel against live stack)
npm run test:all          # all 151 tests
npm run smoke             # end-to-end smoke against running gateway (loopback:8080)
npm run migrate           # apply pending migrations
docker compose up --build
```

### Production Config Validation

```bash
PRODUCTION_MODE=true \
AUTH_REQUIRED=true \
INTERNAL_AUTH_REQUIRED=true \
INTERNAL_SERVICE_TOKEN=prod-internal-token-a1b2c3d4e5f6 \
CORS_ORIGIN=https://treasury.example.com \
DATABASE_URL=postgres://db.internal:5432/treasury_prod \
NODE_ENV=production \
SESSION_COOKIE_SECURE=true \
WEBHOOK_SECRET=prod-webhook-secret-xyz \
npm run check
```

### DB Invariants

```bash
psql "${DATABASE_URL:-postgres://127.0.0.1:5432/treasury_dev}" -X -A -F $'\t' -c "
SELECT 'negative_balances' AS check, COUNT(*) FROM wallet.wallet_balances WHERE balance < 0
UNION ALL
SELECT 'ledger_imbalances', COUNT(*) FROM (
  SELECT lt.id
  FROM wallet.ledger_transactions lt
  JOIN wallet.ledger_entries le ON le.transaction_id = lt.id
  GROUP BY lt.id
  HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE -le.amount END) <> 0
) s
UNION ALL
SELECT 'jobs_without_tenant', COUNT(*) FROM platform.jobs WHERE tenant_id IS NULL
UNION ALL
SELECT 'outbox_without_tenant', COUNT(*) FROM platform.outbox_events WHERE tenant_id IS NULL;"
-- Expected: all zeros.
```

## Readiness Endpoints

- Gateway: `GET /ready`, `GET /health`, `GET /metrics`
- Any service: `GET /health`, `GET /ready` (checks its own DB connection), `GET /metrics`
- Frontend: `GET /` → `apps/web/index.html` (served by gateway)

## V6 Readiness Definitions

- **Demo:** GO — 125 tests green, smoke passes, all V6 epics complete.
- **Investor diligence:** GO — Epics 0, 1, 2, 3, 4, 6 complete. Real four-eyes
  governance with verified identity, tamper-evident audit with nightly verification,
  self-alerting watchdog, defense-in-depth with per-service roles + RLS, dependency-free
  strict CSP, provider adapter seam ready for the first sandbox rail.
- **Production money movement:** STILL NO-GO. Becomes conditional-GO only after
  the external infrastructure items below are executed by humans and a real rail
  passes sandbox certification (Task 5.3). No document may claim otherwise.

## External Infrastructure Tracker (Task 7.2)

These items are human-executed, not agent-executable. Each requires cloud accounts,
operational decisions, and linked evidence before leaving "Not started".

| # | Item | Owner | Status | Evidence |
|---|---|---|---|---|
| 1 | Secrets manager (ADR-008) | — | Not started | — |
| 2 | Managed Postgres + PITR + restore drill | — | Not started | — |
| 3 | WAF / DDoS protection | — | Not started | — |
| 4 | mTLS or private networking between services | — | Not started | — |
| 5 | Centralized logs and metrics | — | Not started | — |
| 6 | Alert routing and on-call | — | Not started | — |
| 7 | Environment promotion pipeline (dev → staging → prod) | — | Not started | — |
| 8 | TLS certificate provisioning and renewal | — | Not started | — |
| 9 | Container image signing and attestation | — | Not started | — |
| 10 | `SERVICE_DB_PASSWORD` rotated from dev default | — | Not started | — |
| 11 | IaC provisioning (`infra/`) executed against a real account | — | Not started | — |
| 12 | Sandbox custody partner integration (Task 5.3) | — | Not started | — |

Rule: no item leaves "Not started" without linked evidence (console screenshot, IaC
apply output, drill writeup, partner certification report).
