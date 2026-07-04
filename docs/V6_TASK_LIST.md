# V6 Task List — From Hardened Demo to Operable Pilot

Companion to `docs/V6_PLAN.md`. Task IDs are stable; dependencies reference them explicitly.
Conventions match `docs/PRODUCTION_MVP_BACKLOG.md`: Priority P0–P3, Complexity S/M/L/XL,
Risk = risk of *not* doing it.

Approval gates (from the plan; an epic marked with a gate is **blocked** until a human approves):

| Gate | Scope | Blocks |
|---|---|---|
| A1 | `payment.payment_approvals` table, `payments.created_by`, approval semantics change | Epic 1 |
| A2 | Per-service Postgres roles + RLS policies | Epic 2 |
| A3 | `operations.audit_events` gains `row_hash`/`prev_hash` (additive) | Epic 3 |
| A4 | Backfill + `NOT NULL` on `identity.sessions.csrf_token` | Task 0.2 |
| A5 | Adapter interface + `operations.providers` columns (`capabilities`, `environment`, `adapter`) | Epic 5 |
| A6 | Infra ADRs: secrets manager, IaC tool, runtime target; OIDC in/out for pilot | Epic 7, Task 4.3, Task 5.3 |

Unblocked without any approval: Tasks 0.1, 0.3, 0.4, Epic 4 (except 4.3), Epic 6.

## Definition of Done (applies to every task)

- Implementation matches existing architecture and service boundaries.
- Focused tests exist that fail against the old behavior.
- `npm run check` and `npm run test:all` pass; smoke passes against a live local stack.
- DB invariant query returns all zeros (extended query after Task 1.5 / 3.2 land).
- UI renders without console errors where the task touches the frontend.
- Docs claim exactly what is proven — no more.

---

## Epic 0 — Truth Reconciliation and Carried Debt

### Task 0.1 — Rewrite `docs/PRODUCTION_READINESS.md` to match delivered reality

- Priority: P0
- Risk: Medium — the doc currently understates M2–M5 (lists ledger/saga/RBAC as "still required"); an investor reading it draws wrong conclusions in the safe-but-confusing direction.
- Complexity: S
- Dependencies: none
- Gate: none
- Components: `docs/PRODUCTION_READINESS.md`
- Subtasks:
  - [x] Inventory delivered capabilities milestone by milestone (M0–M5 + V5/V5.1) with, for each claim, the test file or probe that proves it (e.g. ledger append-only → `tests/integration/payment-transitions-db.test.mjs`; CSRF strictness → `tests/integration/auth-rbac.test.mjs` + `tests/unit/auth.test.mjs`).
  - [x] Restate the not-delivered list from `docs/V6_PLAN.md` G1–G12, each linking to its V6 epic or an explicit out-of-scope note.
  - [x] Keep the "Still Required Before Real Money" framing but scope it to the true remainder (infrastructure phase + Epic 5.3 sandbox certification).
  - [x] Refresh the test-count and command sections (95 tests as of V5.1; commands unchanged).
- Acceptance Criteria:
  - [x] Every "delivered" claim carries a test/probe reference.
  - [x] No delivered feature appears in the "still required" list.
- Tests: none (docs) — reviewed against `docs/V6_PLAN.md` gap table.
- Definition of Done: a reader can grade readiness from this doc alone without contradicting the code.

### Task 0.2 — `identity.sessions.csrf_token` NOT NULL migration

- Priority: P1
- Risk: Low — runtime already strict; this closes the schema-level gap and removes a standing caveat.
- Complexity: S
- Dependencies: none
- Gate: **A4**
- Components: `db/migrations/0030_session_csrf_not_null.sql`, `docs/ENVIRONMENT.md`, `docs/V5_COMPLETION_REPORT.md`, `tests/integration/auth-rbac.test.mjs`
- Subtasks:
  - [ ] Migration: `DELETE FROM identity.sessions WHERE csrf_token IS NULL` (a token the browser never received is unusable; deleting forces clean re-login), then `ALTER TABLE identity.sessions ALTER COLUMN csrf_token SET NOT NULL`.
  - [ ] Keep the strict runtime check in `verifyCsrf` (defense in depth, and it also covers empty-string).
  - [ ] Update `docs/ENVIRONMENT.md` § CSRF Sessions and the V5.1 addendum note (the "stays nullable" rationale is superseded).
  - [ ] Keep the existing null-CSRF integration test but adapt it: nulling the column now fails at the DB, so the test asserts the DB rejects the UPDATE, and the empty-string variant still yields `403 csrf_invalid` through the API.
- Acceptance Criteria:
  - [ ] `INSERT INTO identity.sessions` without `csrf_token` fails at the DB.
  - [ ] Existing CSRF regression tests still pass (adapted, not weakened).
- Tests: migration-shape test via existing harness (fresh migrate per test DB) + adapted integration test.
- Definition of Done: no code path or schema state permits a CSRF-less cookie session.

### Task 0.3 — ADR-010: single-process rate limiting accepted for pilot

- Priority: P1
- Risk: Low — the constraint exists either way; undocumented it becomes an accidental claim.
- Complexity: S
- Dependencies: none
- Gate: none
- Components: new `docs/adr/ADR-010-single-process-rate-limiting.md`, `docs/ENVIRONMENT.md`
- Subtasks:
  - [x] Record the decision: in-memory limiter Maps in `packages/shared/http.mjs` (general/state buckets) and `packages/shared/auth.mjs` (login lockout) are per-process; acceptable while each service runs as a single instance; restart clears state.
  - [x] Record the revisit trigger: any horizontal scaling introduced by Epic 7 reopens this as a Redis-or-equivalent task.
  - [x] Add the constraint to `docs/ENVIRONMENT.md` next to the rate-limit variables.
- Acceptance Criteria:
  - [ ] ADR merged; ENVIRONMENT.md states the constraint and the revisit trigger.
- Tests: none (decision record).
- Definition of Done: nobody can read the rate-limit docs and assume distributed enforcement.

### Task 0.4 — Prove CI green in GitHub Actions

- Priority: P0
- Risk: Medium — `.github/workflows/ci.yml` has never executed remotely; "CI exists" is currently an untested claim (listed as a risk in the V5 report).
- Complexity: S
- Dependencies: none
- Gate: none (needs repo push access — flag if the remote isn't configured)
- Components: `.github/workflows/ci.yml`, `README.md`
- Subtasks:
  - [ ] Verify the workflow matches local harness assumptions: Node >= 20, Postgres service container reachable as the admin URL the test helpers expect (`DATABASE_ADMIN_URL` / `postgres://127.0.0.1:5432/postgres`), migrations applied before integration tests.
  - [ ] Push a branch; iterate until the full pipeline (check, unit, integration, concurrency) is green remotely.
  - [ ] Record the green run link in README (badge or note); remove the "CI untested" risk row from `docs/V5_COMPLETION_REPORT.md`.
- Acceptance Criteria:
  - [ ] A linked green Actions run executing all four test stages.
- Tests: the CI run is the test.
- Definition of Done: merge-blocking CI is a demonstrated fact.

---

## Epic 1 — Real Four-Eyes Approvals (Gate A1)

Backlog 4.5.1. Highest product-value epic: today `requiredApprovals=2` is satisfiable by one
user clicking twice, and no approver identity is recorded anywhere.

### Task 1.1 — Approvals schema and legacy backfill

- Priority: P0
- Risk: Critical — the core governance claim of the product is currently a demo affordance.
- Complexity: M
- Dependencies: none within epic
- Gate: **A1**
- Components: `db/migrations/0031_payment_approvals.sql` (number = next free)
- Subtasks:
  - [ ] `payment.payment_approvals (id UUID PK DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, payment_id TEXT NOT NULL REFERENCES payment.payments(id), approver_id TEXT NOT NULL, approver_display TEXT NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(), UNIQUE (payment_id, approver_id))` — match the actual `payments.id` type when writing the migration.
  - [ ] `REVOKE UPDATE, DELETE` on the table (append-only, same pattern as `payment_events`).
  - [ ] Add `payments.created_by TEXT NULL` (nullable: legacy rows have no creator identity).
  - [ ] Backfill: for each existing payment with `approvals > 0`, insert synthetic rows `approver_id = 'legacy:unknown:1..n'`, `approver_display = 'Pre-V6 approval (identity not recorded)'` so the Task 1.5 invariant holds unconditionally. Document the marker in the migration comment.
- Acceptance Criteria:
  - [ ] Duplicate `(payment_id, approver_id)` insert fails at the DB.
  - [ ] `UPDATE`/`DELETE` on approvals denied.
  - [ ] Fresh migrate + seed passes the new invariant immediately.
- Tests: constraint tests in `tests/integration/payment-transitions-db.test.mjs` style (direct DB).
- Definition of Done: schema deployed; enforcement wired in 1.3.

### Task 1.2 — Propagate verified acting-user context to internal services

- Priority: P0
- Risk: High — without this, the approver identity would be a client-suppliable header, i.e. forgeable; it must ride inside the HMAC-signed material.
- Complexity: M
- Dependencies: none within epic (lands before 1.3)
- Gate: A1
- Components: `packages/shared/service-client.mjs`, `packages/shared/http.mjs` (`signInternalRequest` / `verifyInternalRequest` / `validateInternalAuth`), `services/api-gateway/src/index.mjs` (`tenantOptions`)
- Subtasks:
  - [ ] Extend the signed payload from `method|path|body` to `method|path|body|actingUser` where `actingUser` is a compact JSON string `{"id":"…","display":"…"}` (empty string when absent), sent as `X-Acting-User`.
  - [ ] `service-client` accepts `actingUser` in options; gateway passes `{ id: ctx.user.userId, display: ctx.user.displayName }` from the verified session via `tenantOptions`.
  - [ ] `validateInternalAuth` verifies the signature over the header value and exposes `context.actingUser` only when the signature is valid; a mismatched header → `401`.
  - [ ] With `INTERNAL_AUTH_REQUIRED=false` (dev), `context.actingUser` is taken from the header as-is (dev ergonomics; document).
  - [ ] Relay/job workers pass `actingUser = { id: "system:worker", display: "System" }`.
- Acceptance Criteria:
  - [ ] Tampering with `X-Acting-User` after signing → `401 internal_auth_required`.
  - [ ] Downstream audit rows can name the human, not just the calling service.
- Tests: unit tests on sign/verify including the tamper case; integration test with `INTERNAL_AUTH_REQUIRED=true`.
- Definition of Done: no internal mutation trusts a client-suppliable identity header.

### Task 1.3 — Enforce four-eyes in payment-service

- Priority: P0
- Risk: Critical
- Complexity: M
- Dependencies: 1.1, 1.2
- Gate: A1
- Components: `services/payment-service/src/index.mjs` (`approvePayment`, `createPayment`), `services/policy-service` (`validatePolicy`), `packages/shared/*`
- Subtasks:
  - [ ] `createPayment` records `created_by` from `context.actingUser.id` (null in dev mode without auth).
  - [ ] `approvePayment` inside the existing `SELECT ... FOR UPDATE` transaction: insert into `payment_approvals` (DB unique is the race backstop); recompute `approvals` as `COUNT(DISTINCT approver_id)`; transition to `Approved` only when count ≥ `requiredApprovals`.
  - [ ] Same approver twice → `409 already_approved` (catch the unique violation; no partial state).
  - [ ] Creator-cannot-approve when the policy's `selfApprovalAllowed` is false (new policy field, default false): `403 self_approval_forbidden`. Skip the rule when `created_by` is null (legacy/dev), and say so in the response detail.
  - [ ] `validatePolicy` accepts/validates `selfApprovalAllowed` (boolean).
  - [ ] Auto-approved payments (below threshold) write a `payment_approvals` row with `approver_id = 'policy:auto'` and audit action `Payment auto-approved` (existing) so the invariant covers them too.
  - [ ] Dev mode (`AUTH_REQUIRED=false`): acting user defaults to the system identity; approving twice as system in dev is allowed only when `requiredApprovals <= 1` — document that four-eyes semantics require auth mode.
- Acceptance Criteria:
  - [ ] With two distinct approvers, payment reaches `Approved`; with one approver approving twice it stays `PendingApproval` and returns `409`.
  - [ ] Creator approval attempt → `403` when policy forbids.
- Tests: see 1.5; plus unit tests for the policy field validation.
- Definition of Done: the approvals counter can no longer disagree with the approvals table.

### Task 1.4 — UI: approver visibility and guardrails

- Priority: P1
- Risk: Medium — server enforces; UI must not invite dead-end clicks or hide governance evidence.
- Complexity: S
- Dependencies: 1.3
- Gate: A1
- Components: `apps/web/main.js`, `services/api-gateway/src/index.mjs` (expose approvals in state/payment detail)
- Subtasks:
  - [ ] Payment detail lists approvals: display name + timestamp; `policy:auto` rendered as "Auto-approved by policy"; legacy marker rendered as "Pre-V6 approval".
  - [ ] Approve button disabled with tooltip when the current user is the creator (server still enforces).
  - [ ] Approve button reflects `already_approved` state for the current user.
- Acceptance Criteria:
  - [ ] Browser check: full approve flow with two users shows both names; no console errors.
- Tests: smoke-level; browser check in the loop.
- Definition of Done: governance evidence is visible where treasurers look for it.

### Task 1.5 — Adversarial tests and approvals invariant

- Priority: P0
- Risk: Critical — this epic without adversarial proof would repeat the V5 lesson (green suite, real gap).
- Complexity: M
- Dependencies: 1.1–1.3
- Gate: A1
- Components: `tests/integration/auth-rbac.test.mjs` or new `tests/integration/approvals.test.mjs`, `tests/concurrency/payment-races.test.mjs`, invariant SQL in docs + `docs/RELEASE_CHECKLIST.md`
- Subtasks:
  - [ ] Integration (AUTH_REQUIRED=true stack): two distinct approvers → `Approved`; same user twice → `409`; creator self-approve → `403`; N-1 distinct approvers → still `PendingApproval`.
  - [ ] Adversarial: direct payment-service call with forged `X-Acting-User` and no/invalid signature (`INTERNAL_AUTH_REQUIRED=true`) → `401`.
  - [ ] Concurrency: N parallel approve calls by the same user → exactly one approval row; N parallel approvals by two users on a 2-approval payment → exactly 2 rows, exactly one transition to `Approved`.
  - [ ] Extend the standard invariant query: `SELECT 'approval_rows_lt_count', COUNT(*) FROM payment.payments p WHERE p.approvals > (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals a WHERE a.payment_id = p.id)` → 0. Add to `docs/V6_PLAN.md` loop, `docs/RELEASE_CHECKLIST.md`, and the fix-instruction template.
- Acceptance Criteria:
  - [ ] All listed probes pass; reverting any 1.3 rule makes at least one test fail.
- Definition of Done: four-eyes claims are test-backed end to end.

---

## Epic 2 — Database Defense in Depth: Roles + RLS (Gate A2)

Backlog 1.1.1 (deferred role isolation) + 4.4.1. Migrate **one schema at a time** in the
order policy → compliance → operations → reconciliation → accounting → wallet → payment,
full suite green after each step.

### Task 2.1 — Per-service Postgres roles

- Priority: P1
- Risk: High — today any service role can read every schema; one compromised service reads the ledger.
- Complexity: L
- Dependencies: none within epic
- Gate: **A2**
- Components: new migration(s), `packages/shared/db.mjs`, `tests/helpers/stack.mjs`, `scripts/dev.mjs`, `docker-compose.yml`, `.env.example`
- Subtasks:
  - [ ] Migration creates cluster-level roles idempotently (`DO $$ ... IF NOT EXISTS (SELECT FROM pg_roles ...)`) — roles are cluster-wide while grants are per-database, so parallel test databases share roles safely.
  - [ ] One role per service (`svc_wallet`, `svc_payment`, `svc_policy`, `svc_compliance`, `svc_accounting`, `svc_reconciliation`, `svc_operations`, `svc_gateway`, `svc_relay`, `svc_job`); `GRANT USAGE` + table privileges only on the service's own schema.
  - [ ] `platform` schema grants scoped to actual use: outbox writers (domain services), relay (read/update outbox), job worker (jobs tables), inbox per consumer. Derive from real query inventory, not guesswork — grep `query(` call sites per service first.
  - [ ] `identity` schema: gateway only. `operations.audit_events` INSERT: gateway (`emitSecurityAudit`) + operations service.
  - [ ] Per-service connection: each service's env gets a role-scoped `DATABASE_URL` (dev: password from a single dev secret; test harness constructs URLs in `stack.mjs`; compose updated).
  - [ ] Negative test per service: wallet role `SELECT payment.payments` → permission denied (loop over a service × foreign-schema matrix).
- Acceptance Criteria:
  - [ ] Full suite green with every service on its own role.
  - [ ] Cross-schema access matrix test passes (all denials denied, all legitimate grants working).
- Tests: role-permission matrix integration test; existing suite as the regression net.
- Definition of Done: a service credential leak no longer exposes other domains' data.

### Task 2.2 — Row-level security on tenant-scoped tables

- Priority: P1
- Risk: High — tenant isolation currently depends on every WHERE clause being right forever.
- Complexity: L
- Dependencies: 2.1 (services must already connect as non-owner roles so RLS applies)
- Gate: A2
- Components: migrations per schema, `packages/shared/db.mjs`
- Subtasks:
  - [ ] `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation ... USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` on every tenant-scoped table, schema by schema.
  - [ ] `db.mjs`: every query/transaction sets `app.tenant_id` from verified request context (`SET LOCAL` inside transactions; wrap bare queries in transactions where needed).
  - [ ] Workers that legitimately operate across tenants (relay poll, job claim, watchdog): decide explicitly — either `BYPASSRLS` on `svc_relay`/`svc_job` (documented in the migration and ENVIRONMENT.md) or per-tenant iteration. Recommendation: BYPASSRLS for the two worker roles only; domain services never.
  - [ ] Interaction checks: `SELECT ... FOR UPDATE` under RLS, the deferred balanced-ledger trigger, and `ON CONFLICT` idempotency inserts — cover each with an explicit test before moving to the next schema.
- Acceptance Criteria:
  - [ ] A deliberately WHERE-less `SELECT` executed as a domain service role with tenant 1 context returns zero tenant-2 rows.
  - [ ] Full suite + concurrency suite green after every schema's migration.
- Tests: RLS probe test (raw SQL through the service pool); existing cross-tenant suite as net.
- Definition of Done: tenant isolation holds even against application-layer query bugs.

### Task 2.3 — Cross-tenant adversarial suite extension

- Priority: P1
- Risk: Medium
- Complexity: M
- Dependencies: 2.2
- Gate: A2
- Components: `tests/integration/` (extend tenant tests)
- Subtasks:
  - [ ] Idempotency-key collision across tenants → two distinct payments, no leakage.
  - [ ] Webhook for provider of tenant B cannot move tenant A payments (tenant derived from provider config — assert under RLS too).
  - [ ] Repair endpoints, attempts listing, and audit reads scoped under RLS.
  - [ ] Add the WHERE-less probe to `docs/RELEASE_CHECKLIST.md` adversarial section.
- Acceptance Criteria:
  - [ ] All probes pass; each new probe fails when its RLS policy is dropped in a scratch DB.
- Definition of Done: cross-tenant impossibility is demonstrated at API and DB layers.

---

## Epic 3 — Tamper-Evident Audit (Gate A3)

### Task 3.1 — Audit hash chain

- Priority: P1
- Risk: Medium-High — REVOKE stops the app, not a superuser or a compromised migration path; auditors ask for tamper-evidence.
- Complexity: M
- Dependencies: none (alerting integration benefits from 6.2 but does not block)
- Gate: **A3**
- Components: `db/migrations/00xx_audit_hash_chain.sql`, `services/operations-service/src/index.mjs` (`/audit` insert), `packages/shared/auth.mjs` (`emitSecurityAudit`)
- Subtasks:
  - [ ] Add `prev_hash TEXT` and `row_hash TEXT` to `operations.audit_events`; chain is **per tenant** (tenant chains stay independent and exportable).
  - [ ] Canonical hash material: `sha256(tenant_id|id|actor|action|object|detail|at|prev_hash)` over a documented canonical serialization — write the spec in the migration comment and a shared helper used by **both** insert paths.
  - [ ] Serialize chain appends per tenant with `pg_advisory_xact_lock(hashtext(tenant_id::text))` inside the insert transaction to prevent prev_hash races under concurrency.
  - [ ] Migration backfills the chain over existing rows ordered by `(at, id)` per tenant.
  - [ ] Keep `emitSecurityAudit`'s never-block-the-operation property: hash failure logs loudly but does not fail login/logout (document the trade-off — a dropped audit row is itself detectable as a chain gap only if inserts fail closed; state the chosen semantics explicitly).
- Acceptance Criteria:
  - [ ] Concurrent audit inserts (N parallel) produce a valid unbroken chain.
  - [ ] Both insert paths (operations `/audit`, gateway `emitSecurityAudit`) produce chain-valid rows.
- Tests: concurrency chain test; unit test for canonical serialization stability.
- Definition of Done: every audit row commits to its predecessor.

### Task 3.2 — Chain verifier, nightly job, runbook

- Priority: P1
- Risk: Medium — a chain nobody verifies is decoration.
- Complexity: S
- Dependencies: 3.1; alert delivery via 6.2 (fallback: direct alert insert)
- Gate: A3
- Components: new `scripts/verify-audit-chain.mjs`, job worker (new job type), `docs/RUNBOOKS.md`, `docs/RELEASE_CHECKLIST.md`
- Subtasks:
  - [ ] `scripts/verify-audit-chain.mjs`: walks each tenant chain, exits non-zero naming the first broken row; runnable standalone against `DATABASE_URL`.
  - [ ] Durable job `audit-chain-verify` (nightly via `run_at` rescheduling) reusing the same verification module; on break: insert an operations alert (type `audit_chain_break`).
  - [ ] Test: corrupt one row's `detail` in a scratch DB → verifier detects, names the row; job path produces the alert.
  - [ ] Runbook entry: meaning of a break, damage bounding (last-valid row), evidence handling, escalation.
  - [ ] Add verifier to the standard verification loop and release checklist.
- Acceptance Criteria:
  - [ ] Verifier exit 0 on healthy DB; non-zero + row identification on corrupted scratch DB; alert row created by the job path.
- Definition of Done: tampering is detected within one job interval, with an operator playbook.

---

## Epic 4 — Session and Edge Hardening

### Task 4.1 — Cookie hardening: `__Host-` prefix, rotation, idle timeout, logout clearing

- Priority: P1
- Risk: Medium
- Complexity: M
- Dependencies: none
- Gate: none
- Components: `packages/shared/auth.mjs`, `services/api-gateway/src/index.mjs`, `apps/web/main.js`, `db/migrations/` (idle-timeout column if needed), `docs/ENVIRONMENT.md`
- Subtasks:
  - [ ] `__Host-session` / `__Host-csrf` cookie names when `SESSION_COOKIE_SECURE=true` (prefix requires `Secure`, `Path=/`, no `Domain` — all already true). Cookie parsing (`extractToken`, frontend `document.cookie` read) accepts both names; plain names remain for non-secure local dev. Tests cover both modes.
  - [ ] Session rotation: successful login destroys any session presented in the request cookie before issuing the new one (prevents fixation).
  - [ ] Idle timeout: sliding `expires_at` bump on `validateSession` (bump at most once per minute to avoid write amplification) with an absolute cap from session creation (`SESSION_IDLE_TTL_MINUTES`, `SESSION_ABSOLUTE_TTL_HOURS`; defaults preserve current 24 h behavior). Uses existing `expires_at` + `created_at`; add `created_at` column only if missing.
  - [ ] Logout response sets both cookies with `Max-Age=0` (today only the DB row is destroyed; the stale cookie lingers client-side).
  - [ ] Document all new env vars in `docs/ENVIRONMENT.md`.
- Acceptance Criteria:
  - [ ] Login with a valid old session cookie yields a different session token and the old one is dead.
  - [ ] A session idle past `SESSION_IDLE_TTL_MINUTES` → 401; an active session never outlives the absolute cap.
  - [ ] After logout, response cookies are cleared and the old token is rejected.
- Tests: integration tests per behavior (secure-mode stack via `extraEnv`); unit tests for cookie header construction.
- Definition of Done: session lifecycle matches stated policy under test.

### Task 4.2 — Security headers for the served UI

- Priority: P2
- Risk: Low-Medium
- Complexity: S
- Dependencies: none
- Gate: none
- Components: `packages/shared/http.mjs` (`setBaseHeaders` / `serveStatic`)
- Subtasks:
  - [ ] CSP on gateway HTML responses: `default-src 'self'` (frontend is dependency-free — verify `apps/web/index.html` has no inline script/style first; if inline styles exist, decide hash-based allowance over `unsafe-inline`).
  - [ ] `frame-ancestors 'none'` (CSP) + `X-Frame-Options: DENY`.
  - [ ] HSTS documented as ingress duty (not set by the app; note in ENVIRONMENT.md).
  - [ ] Browser check: UI fully functional with CSP active, zero console violations.
- Acceptance Criteria:
  - [ ] Headers present on `/` responses; UI renders and operates cleanly.
- Tests: integration assertion on response headers; browser check in the loop.
- Definition of Done: served UI carries a strict, working CSP.

### Task 4.3 — OIDC scope decision (decision only in V6 unless pulled in)

- Priority: P2 (decision) / P1 (implementation, only if a pilot partner needs SSO)
- Risk: Medium — pilot-blocking only if a design partner mandates SSO.
- Complexity: S (decision) / L (implementation)
- Dependencies: none
- Gate: **A6** (scope decision)
- Components: decision record; if pulled in: `services/api-gateway`, compose (Keycloak), `apps/web/main.js`
- Subtasks:
  - [ ] Record the decision (ADR-011): local login only for pilot vs generic OIDC code flow.
  - [ ] If pulled in: Keycloak in compose as dev IdP; OIDC login alongside local login behind a flag; sessions/CSRF unchanged post-login.
- Acceptance Criteria: ADR merged; if implemented, login via IdP produces a normal platform session with tests.
- Definition of Done: SSO posture is a recorded decision, not an omission.

---

## Epic 5 — Provider Adapter Seam + Reconciliation Ingestion (Gate A5)

### Task 5.1 — Custody adapter interface behind the saga

- Priority: P1
- Risk: High — without the seam, the first real rail integration lands directly inside the saga, the most dangerous place to improvise.
- Complexity: M
- Dependencies: none within epic
- Gate: **A5**
- Components: new `packages/shared/adapters/custody.mjs` (or `services/payment-service/src/adapters/`), `db/migrations/00xx_provider_adapters.sql`, `services/payment-service` (saga step 3), `services/operations-service` (provider health)
- Subtasks:
  - [ ] Interface: `CustodyAdapter { getBalances(walletRef), submitTransfer(request) -> {providerRef}, getTransferStatus(providerRef) -> {status} }`; current simulated execution becomes `SimulatedCustodyAdapter` implementing it.
  - [ ] `operations.providers` gains `capabilities JSONB`, `environment TEXT CHECK (environment IN ('sandbox','prod'))`, `adapter TEXT` (registry key); seeds updated (`environment='sandbox'`).
  - [ ] Adapter registry resolves per provider row; unknown adapter → provider unusable, alert-worthy, never a crash.
  - [ ] Circuit breaker wrapper: open after N consecutive failures, half-open probe, per provider instance; breaker state surfaces in `/metrics` (feeds 6.1) and provider health drives the existing policy provider-route check.
  - [ ] **Zero-behavior-change requirement**: with `SimulatedCustodyAdapter`, the full suite passes unchanged — this proves the seam is pure refactor.
- Acceptance Criteria:
  - [ ] Suite green with no test modifications (except new adapter-specific tests).
  - [ ] Breaker opens/half-opens/closes under an injected failing adapter in tests.
- Tests: unit tests for breaker state machine; saga integration tests via injected failing adapter (reuse `saga-failure` patterns).
- Definition of Done: the saga's provider step is an interface call; the simulated rail is just one implementation.

### Task 5.2 — Provider statement ingestion and matching (simulated statements first)

- Priority: P1
- Risk: Medium-High — recon currently only self-references our own events; it cannot catch what a provider disagrees about, which is reconciliation's whole point.
- Complexity: L
- Dependencies: 5.1 (statement emission from the simulated adapter)
- Gate: A5
- Components: `db/migrations/00xx_provider_statements.sql`, `services/reconciliation-service`, new `scripts/ingest-statement.mjs`, `tests/integration/`
- Subtasks:
  - [ ] `reconciliation.provider_statements (tenant_id, provider_id, external_id UNIQUE per provider, period, received_at)` + `statement_lines (statement_id FK, provider_ref, amount NUMERIC, asset, occurred_at, raw JSONB)`.
  - [ ] Internal ingestion endpoint (internal-auth protected) + file-drop script for JSON statements.
  - [ ] Matcher (durable job): match lines by `provider_ref` first, then amount+date+wallet heuristic with recorded confidence; unmatched → exceptions with reason category (`missing_ours`, `missing_theirs`, `amount_mismatch`, `fee_mismatch`, `duplicate`).
  - [ ] `SimulatedCustodyAdapter` emits a statement line on settlement so the E2E path (settle → ingest → match) runs in tests without a partner.
  - [ ] Exception lifecycle reuses the existing resolve flow; aging from timestamps (existing pattern).
- Acceptance Criteria:
  - [ ] E2E test: settled payment + ingested statement → matched row; each mismatch category → correct exception.
  - [ ] Duplicate statement ingestion (same external_id) is idempotent.
- Tests: matcher unit tests per category; ingestion idempotency; E2E integration.
- Definition of Done: reconciliation compares us against a provider's view, not against ourselves.

### Task 5.3 — First real sandbox rail (BLOCKED — external)

- Priority: P2 (tracked; not startable in-repo)
- Risk: High for the pilot timeline; zero implementation risk until unblocked.
- Complexity: XL when unblocked
- Dependencies: 5.1, 5.2, **partner selection (business)**, **secrets manager (Epic 7 / A6)** — backlog rule: no real credential before a secrets manager.
- Gate: A5 + A6 + business input
- Subtasks (for when unblocked — do not start):
  - [ ] Sandbox credentials via secrets manager only; sandbox `CustodyAdapter` implementation; provider refs replace simulated refs; tagged credentialed contract tests in CI; balance reconciliation custody-vs-ledger.
- Definition of Done: a payment settles end-to-end against the partner sandbox; certification evidence filed.

---

## Epic 6 — Money-Path Observability and Alerting

### Task 6.1 — Money-path metrics

- Priority: P1
- Risk: High — today a stuck saga or growing DLQ is invisible until a user notices.
- Complexity: M
- Dependencies: none
- Gate: none
- Components: `services/relay-worker`, `services/job-worker`, `services/payment-service` (`/metrics`), `packages/shared/http.mjs`
- Subtasks:
  - [ ] Relay `/metrics`: outbox lag (age of oldest unpublished event, seconds), unpublished count, delivery failure count.
  - [ ] Job worker `/metrics`: queue depth, dead-letter count, oldest pending job age (extends existing claimed/completed/failed counters).
  - [ ] Payment `/metrics`: payments per state with max time-in-state, saga step failure counts (from `payment_execution_attempts`), stuck-`Executing` count over threshold.
  - [ ] Gateway `/metrics`: webhook signature-failure count; circuit-breaker states per provider (after 5.1; degrade gracefully if 5.1 not landed).
  - [ ] Metric DB queries must be cheap (indexed) and never block request handling; compute on scrape with a short cache.
- Acceptance Criteria:
  - [ ] Each metric moves correctly under an integration test that manufactures its condition (e.g. halt relay → outbox lag grows).
- Tests: integration assertions on `/metrics` JSON after induced conditions.
- Definition of Done: every silent-failure channel identified in the plan has a number attached.

### Task 6.2 — Internal watchdog and alert loop

- Priority: P1
- Risk: High — metrics nobody watches don't alert anyone; the alerts UI panel exists but carries no operational signal.
- Complexity: M
- Dependencies: 6.1 (thresholds read the same queries); 3.2 integrates here when landed
- Gate: none
- Components: job worker (new job type `ops-watchdog`), `services/operations-service` (alerts), `docs/RUNBOOKS.md`, `docs/ENVIRONMENT.md`
- Subtasks:
  - [ ] Durable job `ops-watchdog` every `WATCHDOG_INTERVAL_MS` (rescheduling via `run_at`): evaluates stuck `Executing` payments (> `WATCHDOG_STUCK_EXECUTING_MS`), outbox lag > threshold, DLQ > 0, oldest pending job age > threshold, audit chain break (once 3.2 lands).
  - [ ] Alert dedupe: one **open** alert per (type, subject); condition clearing resolves the alert; no alert storms on repeated evaluation.
  - [ ] Alert rows flow through the existing operations alerts path so the UI panel and audit trail pick them up unchanged.
  - [ ] Runbook entry per alert type with the operator action (repair endpoint, relay restart, DLQ drain — reference existing `docs/RUNBOOKS.md` procedures).
  - [ ] Env vars documented; watchdog disabled cleanly when interval unset in tests that don't want it.
- Acceptance Criteria:
  - [ ] Integration: manufacture a stuck `Executing` payment → alert appears within one interval → repair → alert resolves.
  - [ ] Repeated evaluation of a persisting condition yields exactly one open alert.
- Tests: integration with short intervals via `extraEnv`.
- Definition of Done: the platform notices its own failure modes before a user does.

### Task 6.3 — Log hygiene adversarial probe

- Priority: P1
- Risk: Medium — a single leaked session token in logs undoes cookie security.
- Complexity: S
- Dependencies: none
- Gate: none
- Components: `tests/integration/` (new test using `stack.mjs` captured child logs)
- Subtasks:
  - [ ] Run a full lifecycle on an auth-required stack: login, payment create/approve/execute, webhook delivery, logout.
  - [ ] Collect all captured child stdout/stderr (extend `stack.mjs` log capture window if 80 lines is too small — make the cap configurable via option).
  - [ ] Assert zero occurrences of: the session token value, csrf token value, the password, `INTERNAL_SERVICE_TOKEN` value, webhook secret value.
  - [ ] Add the probe to `docs/RELEASE_CHECKLIST.md`.
- Acceptance Criteria:
  - [ ] Probe passes; deliberately logging a token in a scratch branch makes it fail.
- Definition of Done: log discipline is enforced by a test, not a convention.

---

## Epic 7 — Deployment Scaffolding and Infrastructure Boundary (Gate A6)

### Task 7.1 — In-repo scaffolding (agent-executable)

- Priority: P2
- Risk: Medium — prepares the infra phase; must never be reported as "infrastructure done".
- Complexity: M
- Dependencies: A6 decisions for the IaC tool (skeleton can default to Terraform and note the ADR)
- Gate: A6 (partial — container/CI subtasks are unblocked)
- Components: `Dockerfile`/`docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example` variants, new `infra/`
- Subtasks:
  - [ ] Container hardening: read-only root filesystem, tmpfs where needed, drop capabilities, healthcheck tuning (non-root already done).
  - [ ] CI: add image build + vulnerability scan stage (e.g. trivy action), merge-blocking.
  - [ ] Per-environment config shapes: `.env.example.dev` / `.env.example.staging` / `.env.example.prod` all validated by the existing prod-config gate in CI (prod shape must pass `PRODUCTION_MODE=true npm run check`).
  - [ ] `infra/` Terraform skeleton: modules for network (private subnets, gateway-only ingress), managed Postgres (PITR flagged), secrets-manager references, WAF-fronted load balancer — **plan artifacts only**; `infra/README.md` opens with "nothing here is provisioned".
- Acceptance Criteria:
  - [ ] Compose stack runs with hardened containers; CI scan stage green.
  - [ ] `terraform validate` passes on the skeleton; no state, no credentials anywhere.
- Tests: CI is the test for scan/config stages; compose smoke locally.
- Definition of Done: the infra phase has a concrete starting point and an honest boundary.

### Task 7.2 — External infrastructure tracker (human-executed; agent tracks only)

- Priority: P0 to track, external to execute
- Risk: Critical for production go-live; none for the demo.
- Complexity: — (not agent-executable)
- Dependencies: A6 ADRs (secrets manager, IaC tool, runtime target)
- Components: `docs/PRODUCTION_READINESS.md` (single source of truth for this table)
- Subtasks:
  - [ ] Maintain the external-items table: secrets manager, managed Postgres + PITR + restore drill, WAF/DDoS, mTLS or private networking, centralized logs/metrics, alert routing/on-call, environment promotion — each with owner and status (all `Not started` today).
  - [ ] Rule: no item leaves `Not started` without linked evidence (console screenshot, IaC apply output, drill writeup).
- Acceptance Criteria:
  - [ ] `docs/PRODUCTION_READINESS.md` lists every external item with owner + status at all times.
- Definition of Done (V6 scope): the boundary is documented and truthful; execution is a human milestone, not a V6 deliverable.

---

## Epic 8 — Standing Verification (runs after every epic)

- Priority: REQUIRED
- Loop (unchanged from V5): `npm run check` → `npm run test:all` → prod-config gate → `npm run migrate` + `npm run dev` + `/health` + `/ready` + `npm run smoke` → DB invariants → browser/UI check → docs reconciliation → PROJECT_STATE.md session log.
- V6 invariant-query additions (land with their epics):
  - [ ] Approvals integrity (Task 1.5): `approval_rows_lt_count` → 0.
  - [ ] Audit chain: `scripts/verify-audit-chain.mjs` exit 0 (Task 3.2).
- V6 adversarial-probe additions to `docs/RELEASE_CHECKLIST.md` (land with their epics):
  - [ ] Same-user double approval → `409`; creator self-approval → `403`; forged acting-user header → `401`.
  - [ ] Cross-schema SELECT under a service role → denied; WHERE-less query under RLS → zero foreign-tenant rows.
  - [ ] Corrupted audit row → detected by verifier; alert row created.
  - [ ] Stuck `Executing` payment → alert within one watchdog interval; resolves after repair.
  - [ ] Full-lifecycle log grep for secrets → zero hits.
  - [ ] `__Host-` cookies present in secure mode; logout clears cookies; fixated session rotated on login.

---

## Suggested Execution Order

```text
1. Task 0.1, 0.3, 0.4          (unblocked, cheap, keeps claims honest)
2. Epic 6 (6.1 → 6.2 → 6.3)    (unblocked; makes every later epic observable)
3. Epic 4 (4.1 → 4.2)          (unblocked; 4.3 is a decision)
4. Task 0.2                    (on A4 approval)
5. Epic 1 (1.1 → 1.2 → 1.3 → 1.4 → 1.5)   (on A1; highest product value)
6. Epic 3 (3.1 → 3.2)          (on A3; alert delivery from 6.2 already in place)
7. Epic 2 (2.1 → 2.3)          (on A2; schema-by-schema, after 1 & 3 tables exist)
8. Epic 5 (5.1 → 5.2)          (on A5; 5.3 stays blocked externally)
9. Task 7.1                    (container/CI parts anytime; IaC skeleton after A6)
10. Task 7.2                   (continuous tracking)
```

Parallelization: Epic 6 and Epic 4 touch disjoint surfaces from Epic 1 and can run alongside
it. Epic 2 must run alone (schema-wide migrations) with the suite green after each schema.

## Session Rules (unchanged)

- One task (or tightly coupled task pair) per work session; update `PROJECT_STATE.md` after each.
- Schema, payment-semantics, auth-policy, and tenant-assumption changes require the mapped
  approval gate before any code is written.
- No task is done at "code compiles" — done means the Epic 8 loop passed and the docs say
  exactly what is now true.
