# V6 Audit Report — Gaps and Bugs

Date: 2026-07-06. Auditor: Fable5 (adversarial code audit, whole project).
Baseline at audit time: **125/125 tests green** (49 unit + 72 integration + 4 concurrency),
5 DB invariants zero, audit chain intact. Every finding below is therefore a gap the green
suite does **not** cover. Nothing was fixed during this audit; each finding names its
evidence so it can be verified or falsified independently.

## HIGH

### H1 — `ALLOW_DEMO_RESET` is a documented control that does not exist
- Evidence: `grep -rn ALLOW_DEMO_RESET packages/ services/ scripts/` → **zero hits**. The
  variable appears only in `docs/ENVIRONMENT.md` ("Allow reset in production") and
  `docs/RELEASE_CHECKLIST.md` ("Demo reset disabled: ALLOW_DEMO_RESET is not set"), both
  implying `POST /api/reset` is gated in production. No code reads it.
- Impact: in `PRODUCTION_MODE=true`, any holder of `admin:reset` can wipe and reseed
  operational data (payments, wallets, policies, counterparties, **the tenant-1 audit
  trail**) with one HTTP call. This is precisely the "docs claim stronger behavior than the
  code provides" class this project's own rules forbid.
- Suggested fix: production boot gate (or per-request check) that 403s `/api/reset` unless
  the flag is explicitly set; regression test with a production-shaped stack.

### H2 — Demo reset is cross-tenant destructive
- Evidence: tenant-2's admin role holds `admin:reset`
  (`db/migrations/0027_second_tenant_admin_permissions.sql:19`); every service reseed
  hardcodes `DEFAULT_TENANT_ID` (e.g. `services/operations-service/src/seed.mjs`,
  `services/payment-service/src/seed.mjs`) regardless of the caller's tenant.
- Impact: a tenant-2 administrator can destroy and reseed **tenant-1's** data via
  `POST /api/reset` — a cross-tenant destructive action in the one place RLS cannot help
  (the reseeds run with an explicit tenant-1 context by design). The reverse also holds:
  there is no tenant-2 reset at all.
- Suggested fix: scope `admin:reset` effect to the caller's tenant (reseeds parameterized
  by tenant, tenant-2 seed data added) or restrict the permission to a platform-operator
  role; adversarial test: tenant-2 admin reset must not touch tenant-1 rows.

### H3 — Outbox relay has no poison-event handling; ≤20 bad events starve everything
- Evidence: `services/relay-worker/src/index.mjs` — `recordDeliveryAttempt()` sets
  `published_at = NULL` on a row where it is already NULL (**it records nothing**, despite
  the name); there is no attempts column (0013 schema), no cap, no dead-letter, no skip.
  `getUnpublishedEvents` selects `ORDER BY created_at LIMIT 20` (`BATCH_SIZE = 20`).
- Impact: one permanently failing event (poisoned payload, consumer 4xx) retries forever;
  twenty of them block the entire outbox **for all tenants** — audit events and settlement
  side effects stall indefinitely. The watchdog's outbox-lag alert detects the symptom;
  nothing recovers. Jobs have a dead-letter path; outbox events do not.
- Suggested fix: attempts column + backoff + dead-letter status (mirroring
  `platform.jobs`), watchdog check on dead-lettered events, replay tool; failure-injection
  test with a consumer that always 500s for one event while others must still deliver.

## MEDIUM

### M1 — Login returns the raw session + CSRF tokens in the JSON body
- Evidence: `services/api-gateway/src/index.mjs` login response
  `session: { token, csrfToken, expiresAt }`; frontend stores it
  (`apps/web/main.js:226 state.sessionToken = result.session.token`).
- Impact: the HttpOnly cookie's whole point is that JS cannot read the session token — but
  the login response hands it to JS anyway; any XSS can exfiltrate a full session. CSP
  (Epic 4.2) is the only mitigation. This was V5 backlog task 2.3's "preferred hardening"
  and was never done.
- Suggested fix: stop returning the token for browser logins (cookie only); frontend
  needs only a boolean logged-in flag; keep token in body only for a documented
  API-client/bearer flow if one is intended.

### M2 — Background jobs are single-tenant in a multi-tenant system
- Evidence: `services/job-worker/src/index.mjs` — `payment-auto-expiry` filters
  `tenant_id = DEFAULT_TENANT_ID`; `ops-watchdog` runs `runWatchdog(DEFAULT_TENANT_ID)`.
  (The audit-chain verify job IS multi-tenant.)
- Impact: tenant-2 pending payments never auto-expire; tenant-2 stuck payments, DLQ items
  scoped to its flows, etc. never raise alerts. Governance/ops guarantees silently apply
  to tenant 1 only.
- Suggested fix: iterate tenants (SELECT id FROM identity.tenants) in both handlers;
  tests seeded on tenant 2.

### M3 — Append-only guarantees eroded by broad role grants
- Evidence: `db/migrations/0033_service_roles.sql` grants
  `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` per schema — re-granting UPDATE/DELETE on
  append-only tables (`operations.audit_events`, `payment.payment_events`,
  `payment.payment_approvals`, wallet ledger tables) to the owning service roles, and
  `svc_job` gets full DML on ALL payment tables. `0047` additionally grants `svc_job`
  writes on statement tables its handler never touches (it orchestrates over HTTP), with a
  comment asserting the opposite.
- Impact: `REVOKE ... FROM PUBLIC` is moot for svc roles; a compromised service can edit
  its own audit/event history (the hash chain would detect audit edits — payment_events
  and approvals have no chain). Least-privilege posture is weaker than documented.
- Suggested fix: replace blanket grants with per-table grants; keep DELETE only where the
  demo reset needs it, or move reset to an owner-privileged path; drop the unused 0047
  svc_job grants and fix the comment.

### M4 — Circuit breaker has zero test coverage (claimed, not delivered)
- Evidence: `grep -rln "breaker\|withBreaker" tests/` → no hits. The Epic 5.1 session
  report claimed breaker tests.
- Impact: an untested state machine (closed→open→half-open) sits on the money path; a
  breaker that never opens (or never closes) would pass today's suite.
- Suggested fix: unit tests for the state transitions + saga integration test with an
  injected always-failing adapter.

### M5 — Default service-role DB password passes the production gate
- Evidence: `packages/shared/config.mjs` / `scripts/check-prod-config.mjs` never check
  `SERVICE_DB_PASSWORD`; migration 0033 defaults it to `service-dev-password`.
- Impact: production boot with a publicly known DB password for every service role.
- Suggested fix: add to `validateProductionConfig` (reject unset/default in
  PRODUCTION_MODE); config unit test.

### M6 — `docs/PRODUCTION_READINESS.md` contradicts itself
- Evidence: the summary (~line 390) claims "defense-in-depth with per-service roles +
  RLS", while the gap table still lists G2 (roles/RLS), G3 (hash chain), G8 (statement
  ingestion) as open, the "Still Required" list repeats them, and a note says audit rows
  are "not yet tamper-evident" — all three shipped (migrations 0033–0047).
- Impact: the diligence document both over- and under-claims depending on which section a
  reader lands on.
- Suggested fix: reconcile as part of V6 close-out (already a planned task); add claims'
  test references per the Task 0.1 convention.

### M7 — Task 1.4 (approvals UI) reported complete but not implemented
- Evidence: `apps/web/main.js` renders only the `approvals/requiredApprovals` count; no
  approver names/timestamps, no creator-disabled approve button, and the
  `GET /api/payments/:id/approvals` endpoint has zero frontend callers. The task list is
  honest (1.4 subtasks unticked); the Epic 1 session report claimed 1.4 done.
- Impact: governance evidence invisible where treasurers look; server enforcement holds,
  so this is a UX/claim gap, not a security hole.
- Suggested fix: implement 1.4 as specced, or reclassify it as open work in the close-out.

## LOW

- **L1** Tenant 2 has exactly one seeded user (`admin@nordic-holdings.com`) — four-eyes is
  undemonstrable for tenant 2; any `requiredApprovals ≥ 2` payment there is unapprovable.
- **L2** Statement ingestion (`POST /statements`) never validates that `providerId`
  belongs to the caller's tenant; garbage-but-tenant-scoped statements possible.
- **L3** Statements have no gateway/UI exposure — operators cannot see
  matched/exception counts without direct service access.
- **L4** `packages/shared/http.mjs:104–110` — the `rateLimit` service option is shadowed
  by a `const rateLimit` numeric limit inside the guarded block; legal but a readability
  trap around security-relevant code.
- **L5** 81 modified/untracked files spanning ~7 work sessions with no commit checkpoint —
  no bisectability, and one careless git command from losing all of V6.
- **L6** `process-settlement-webhook` only stamps `webhook_events.status`; real provider
  settlement confirmations do not drive the saga ("Future:" comment). Acceptable for the
  simulated rail; must land with Task 5.3.

## Process observation

Three recent session reports contained claims that failed verification: Epic 2.1 ("tests
run under service roles" — a duplicate-key bug kept tests on the admin connection), Epic
5.1 ("breaker tests" — none exist), Epic 1 ("1.4 complete" — not implemented). The
verify-previous-session-first discipline in `docs/V6_REMAINING_TASKS_INSTRUCTION.md` is
what caught them; it should remain mandatory, and session reports should quote the exact
test names they rely on.

## What held up under attack (verified during this audit)

- Suite 125/125 with the harness genuinely on service roles; RLS fail-closed with a
  policy-drop bite test; roles matrix; concurrency suite (idempotency, no double debit,
  approval cap) green under roles+RLS.
- Audit chain verifies clean; tamper/deletion detection and alert dedupe proven by tests.
- Webhook tenant derivation, signature validation, statement ingestion idempotency,
  FK-safe demo reset, and the multi-tenant email login path all intact.
- `webhook_events.status` column exists (settlement handler is consistent with schema) —
  suspected bug, cleared.
- Statement match enqueue is transactional (`enqueueJobInTx`) — suspected gap, cleared.

## Suggested priority

Fix order: H1+H2 together (reset gating + tenant scoping — small, high value), H3 (outbox
dead-letter — the largest real reliability hole), M1 (token in body), M2 (multi-tenant
jobs), M5 (config gate), then M3/M4/M7 with the V6 close-out, L* opportunistically.
H1/H2/M5 are small enough to land as one hardening session with adversarial tests.
