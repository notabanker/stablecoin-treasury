# HANDOFF — Corporate Stablecoin Treasury Platform

Date: 2026-07-06 · HEAD: `5fe4ce6` on `master`, pushed to
[github.com/notabanker/stablecoin-treasury](https://github.com/notabanker/stablecoin-treasury) ·
CI: **green** (run 28815075372 — both jobs: `test` 125/125, `image-scan` Trivy clean) ·
Working tree: clean except this handoff + PROJECT_STATE.md session log.

This is the single catch-up document for a human or agent joining now. It aggregates —
it does not replace — the living docs: `PROJECT_STATE.md` (session-by-session state),
`docs/V6_AUDIT_REPORT.md` (open findings), `docs/V6_COMPLETION_REPORT.md` (V6 evidence),
`docs/LLM_TECHNICAL_HANDOFF_OPEN_FINDINGS.md` (Codex's deep-dive on open findings).

## 1. What this is

A production-grade-track Corporate Stablecoin Treasury Platform (MiCA-style context):
10 Node services (zero deps except `pg`) over one Postgres with schema-per-service,
async payment saga via transactional outbox + durable jobs, double-entry ledger,
DB-enforced payment state machine, multi-tenant with RLS, dependency-free frontend.
Development runs as alternating single-agent sessions (Claude/Fable and Codex, never
parallel) under a strict build-verify-harden loop. Readiness posture (unchanged, per
`docs/V6_COMPLETION_REPORT.md`): **Demo GO · Investor diligence GO · Production money
movement NO-GO** (external infrastructure is human-owned and not started).

## 2. Where we are — delivered and proven

All of V1–V5 plus **V6 is functionally complete** (all epics; close-out docs written).
Everything below is enforced by tests/probes that exist today (125 tests: 49 unit +
72 integration + 4 concurrency; plus live smoke, 5 DB invariants, audit-chain verifier):

- **Money core**: append-only double-entry ledger (balances are a `security_invoker`
  view over entries), DB trigger–enforced payment state machine, transactional
  outbox/inbox with exactly-once effects, durable jobs with dead-letter, async
  execution saga with repair endpoints, idempotency everywhere (concurrency suite).
- **Four-eyes approvals** (V6 E1): identity-tracked `payment_approvals`
  (UNIQUE payment+approver), creator-cannot-approve, approver identity rides inside
  the HMAC-signed internal-auth payload (`X-Acting-User` is unforgeable when
  `INTERNAL_AUTH_REQUIRED=true`), approvals-integrity DB invariant.
- **Defense in depth** (V6 E2): per-service Postgres roles (`svc_*`, migrations
  0033–0036, 0046, 0049) + row-level security on all 8 schemas (0037–0044), fail-closed
  tenant context (AsyncLocalStorage → transaction-local `app.tenant_id`), documented
  carve-outs (identity schema; gateway SELECT-only on providers; BYPASSRLS for the two
  workers). Probes include a policy-drop "bite test".
- **Tamper-evident audit** (V6 E3): per-tenant sha256 hash chain (0032, canonical
  serialization lives ONLY in SQL — `packages/shared/audit.mjs`), standalone verifier
  (`scripts/verify-audit-chain.mjs`), nightly verify job raising a deduped alert.
- **Session/edge hardening** (V6 E4 + V5.1): strict CSRF (incl. logout, NOT NULL
  csrf_token), `__Host-` cookies, session rotation, idle timeout, CSP/X-Frame-Options,
  login lockout with tenant-scoped audit, proxy-aware rate limiting.
- **Provider seam** (V6 E5): `CustodyAdapter` interface + circuit breaker (0045),
  provider statement ingestion with idempotent delivery and a matcher job producing
  categorized exceptions (exact/heuristic/fee_mismatch/amount_mismatch/duplicate/
  missing_ours/missing_theirs), file-drop script, opt-in simulated statement emission.
- **Self-observation** (V6 E6): money-path metrics (outbox lag, DLQ, stuck payments,
  breaker states), ops-watchdog alert loop feeding the existing alerts UI, log-hygiene
  adversarial probe (full lifecycle, zero secrets in logs).
- **Deployment scaffolding** (V6 E7, in-repo half): hardened Dockerfile (non-root, npm
  removed from runtime image, apk upgraded), CI image-scan job (Trivy, blocks HIGH),
  env shapes (`.env.example.{dev,staging,prod}`), Terraform skeleton under `infra/`
  (**plan artifacts only — nothing provisioned**), ADR-011 (OIDC: accepted-deferred to
  V7 unless a pilot partner demands SSO).

## 3. What just happened (last three sessions, chronological)

1. **Whole-project audit** (`docs/V6_AUDIT_REPORT.md`): 3 HIGH / 7 MEDIUM / 6 LOW
   findings — see §4. Audit-only; no fixes applied.
2. **Simplification pass** (new CLAUDE.md rules): dead `stateRefresh` removed, orphan
   imports removed, `withInboxDedup` consolidated into `packages/shared/outbox.mjs`,
   `rateLimit` shadowing renamed, redundant Codex re-grant migration deleted, unused
   `svc_job` statement grants revoked (0049). Zero behavior change; suite stayed 125.
3. **Push + CI repair**: checkpoint commit `ec64725` (98 files). Two CI-only defects
   found and fixed in the process, both now green:
   - `f2d241d` — workflow triggered on `branches: [main]` but the repo uses `master`;
     **CI had never run on a direct push**, only PRs.
   - `5fe4ce6` — `ci.yml` set `SERVICE_DB_PASSWORD=postgres` but migration 0033 bakes
     `service-dev-password` into the `svc_*` roles → every domain service died with
     FATAL auth_failed on CI. **Local pg_hba is `trust`, so role passwords had never
     been checked anywhere before this CI run.** Plus Trivy legitimately blocked on 14
     HIGH CVEs → fixed by `apk upgrade` and removing npm from the runtime image.

## 4. Open work, ranked (the actual backlog)

From `docs/V6_AUDIT_REPORT.md` (2026-07-06), statuses current as of this handoff.
**None of the HIGH/MEDIUM fixes are authorized yet — the human decides order.**
Suggested: H1+H2+M5 as one small hardening session, then H3, M1, M2.

| # | Finding | Status |
|---|---|---|
| H1 | `ALLOW_DEMO_RESET` is documented as the production guard on `POST /api/reset` but **no code reads it** — reset is live in production for any `admin:reset` holder | OPEN |
| H2 | Demo reset is **cross-tenant destructive**: tenant-2 admin holds `admin:reset` (0027) and every reseed hardcodes tenant 1 | OPEN |
| H3 | Outbox relay has **no poison-event handling**: `recordDeliveryAttempt` records nothing, no attempts/cap/dead-letter; `ORDER BY created_at LIMIT 20` → ≤20 permanently failing events starve the whole outbox for all tenants | OPEN |
| M1 | Login returns raw session+CSRF tokens in the JSON body (undermines HttpOnly; frontend only needs a boolean) | OPEN |
| M2 | `payment-auto-expiry` and `ops-watchdog` hardcode tenant 1 — tenant-2 payments never expire/alert | OPEN |
| M3 | Blanket `GRANT ... ON ALL TABLES` (0033) re-granted UPDATE/DELETE on append-only tables to owning roles | PARTIAL — unused svc_job statement grants revoked (0049); per-table tightening + owner-privileged reset path still open |
| M4 | Circuit breaker has zero test coverage (5.1 report claimed tests; none exist) | OPEN |
| M5 | `SERVICE_DB_PASSWORD` default passes the production config gate | OPEN |
| M6 | `docs/PRODUCTION_READINESS.md` self-contradicts (claims RLS in summary, lists it open in the gap table) | OPEN — fold into next docs pass |
| M7 | Approvals UI (Task 1.4) reported complete but not implemented — endpoint `GET /api/payments/:id/approvals` exists with zero frontend callers, no creator-disabled button | OPEN |
| L1–L6 | single tenant-2 user (four-eyes undemonstrable there) · statement ingestion doesn't validate provider ownership · statements invisible in UI · ~~rateLimit shadowing~~ FIXED · ~~uncommitted tree~~ FIXED (pushed) · settlement-webhook handler is a stub until Task 5.3 | mostly OPEN |

Also open:
- **Task 5.3** (first real sandbox rail): hard-blocked on business partner selection +
  an operational secrets manager. Do not start; never place real credentials anywhere.
- **Task 7.2 external items** (secrets manager, managed Postgres+PITR, WAF, mTLS,
  monitoring stack, on-call): human-executed, all "Not started" — tracked in
  `docs/PRODUCTION_READINESS.md`. These are what keeps production money movement NO-GO.
- **V7 planning** is the natural next milestone once audit HIGHs are fixed.
- Hygiene: `docs/V6_TASK_LIST.md` checkbox state is unreliable (several completed tasks
  — 0.2, 1.1–1.3, 2.1, 5.1 — have unticked boxes; sessions did the work but skipped the
  bookkeeping). Trust `PROJECT_STATE.md`, the completion report, and the code/tests.
  0047's comment about svc_job grants is misleading; 0049 is the correction.

## 5. How to work on this repo (non-negotiables)

Read in order at session start: `CLAUDE.md` → `PROJECT_STATE.md` → the instruction it
points to (`docs/V6_REMAINING_TASKS_INSTRUCTION.md` layered on
`docs/V6_EXECUTION_INSTRUCTION.md`) → `AGENTS.md`.

- **Verify the previous session's claims before building on them.** Three session
  reports have contained falsified claims (2.1 roles-under-test, 5.1 breaker tests,
  1.4 UI); the verify-first rule caught all three.
- A task is done only when the full loop passes: `npm run check` → `npm run test:all` →
  prod-config gate (env block in the execution instruction) → `npm run migrate` +
  `npm run dev` + `npm run smoke` → 5-row invariant SQL (docs/RUNBOOKS.md) +
  `node scripts/verify-audit-chain.mjs` → UI check → docs + PROJECT_STATE update.
  **Never skip live smoke** — skipping it shipped a demo-breaking FK bug once already.
- Gates A1–A6 are all APPROVED (PROJECT_STATE § V6 Gate Status). Schema/auth/payment-
  semantics changes beyond approved scope still need the human.
- Docs claim exactly what is proven — no more.

## 6. Traps that have already bitten (don't repeat)

1. `npm run smoke` calls `POST /api/reset` — local disposable state only.
2. Check for a stale stack before `npm run dev`: `lsof -ti :8080` (EADDRINUSE in your
   new stack's log means your "verification" hit old code).
3. Postgres `INSERT ... SELECT $n` does not infer parameter types — cast every `$n`.
4. `inbox_events.event_id` is an FK to outbox — inbox paths are only testable via real
   relayed events, not fabricated `X-Event-Id` headers.
5. New FK-referencing tables break demo-reset delete order silently — update seeds in
   the same change and probe `/api/reset`.
6. Re-run `ls db/migrations | tail` **immediately** before creating a migration —
   Codex sessions interleave between turns and numbers go stale (0048/0049 collision).
7. Local Postgres is `trust`-auth: passwords, and anything else pg_hba-dependent, are
   only truly tested in CI. `ci.yml`'s `SERVICE_DB_PASSWORD` must equal the password
   migration 0033 bakes into the roles (`service-dev-password`).
8. `GRANT ... ON ALL TABLES` covers only tables existing at grant time — new tables
   need explicit grants in their own migration (0035/0036/0047 lesson).
9. Views bypass RLS unless `security_invoker = true` (wallet_balances lesson).
10. Canonical serializations live in exactly ONE place (audit chain = SQL only).
11. After harness/env changes, verify the change is actually in effect — a duplicate
    object key in stack.mjs once silently kept every "role-verified" test on the admin
    connection.

## 7. Quick reference

- **Stack**: Node ≥ 20 ESM, only dep `pg`. 10 services under `services/*/src/index.mjs`
  (gateway :8080 public; wallet/policy/compliance/payment/accounting/reconciliation/
  operations internal; relay + job workers). Shared code in `packages/shared/`.
  Frontend `apps/web/` (dependency-free). Migrations `db/migrations/0001–0049`
  (forward-only; duplicate-prefix lint; 0017 dup is the single grandfathered exception).
- **Tenants**: 1 = Vega Industries `…0001`, 2 = Nordic Holdings `…0002`. Demo logins
  (password `demo123`): `marta@vega-industries.com`, `approver@vega-industries.com`,
  `admin@nordic-holdings.com` (tenant 2's only user — see L1).
- **Auth model**: `AUTH_REQUIRED` (sessions/RBAC/CSRF), `INTERNAL_AUTH_REQUIRED`
  (HMAC service auth, signs acting user), RLS always on (fail-closed). Dev defaults off
  for the first two; the prod-config gate forces them on in `PRODUCTION_MODE`.
- **Tests**: `npm run test` / `test:integration` (sequential, per-test throwaway DBs
  via `tests/helpers/stack.mjs`, `startStack({ extraEnv })`) / `test:concurrency` /
  `test:all`. Env vars for roles: `SERVICE_DB_PASSWORD` (default `service-dev-password`).
- **CI**: `.github/workflows/ci.yml`, triggers on push to master/main + PRs; jobs:
  `test` (full pipeline, `DB_POOL_MAX=2`) and `image-scan` (Trivy, blocks HIGH/CRITICAL).
  Latest green run: 28815075372.
- **Ops scripts**: `scripts/verify-audit-chain.mjs`, `scripts/ingest-statement.mjs`,
  `scripts/repair.mjs`, `scripts/smoke.mjs`, `scripts/check-*.mjs`.
