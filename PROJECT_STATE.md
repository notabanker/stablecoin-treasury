# PROJECT_STATE

This file is the live working memory for AI coding agents. Update it after each focused work session.

## Current Objective

Execute V6 ("From Hardened Demo to Operable Pilot") per `docs/V6_EXECUTION_INSTRUCTION.md`.
All approval gates A1–A6 are APPROVED (see § V6 Gate Status).

## Current Task

**V8 Phase 0** per `docs/V8_TASK_LIST.md` — Epic 0.1 nearly done. **0.1.1 done** (`ALLOW_DEMO_RESET`
gate). **0.1.2 done** (tenant-scoped reseeds): caller tenant only, Nordic tenant-2 baseline,
unknown tenants empty, identity/RBAC untouched, and no global payment-reference sequence reset.
**0.1.3 done**: kept `admin:reset` on each tenant's Admin role (approved 2026-07-12 — reset is
already caller-tenant-scoped via 0.1.2, so no platform-operator role needed); formalized with two
regression tests (symmetric tenant-1↔tenant-2 reset isolation, and an RBAC-surface bite test
asserting admin:reset is granted to exactly {tenant-1 Admin, tenant-2 Admin}).
**0.1.4 BLOCKED**: adversarial HTTP test needs a live gateway booted with `PRODUCTION_MODE=true`
passing `validateProductionConfig` (packages/shared/config.mjs:29, hard synchronous throw at
services/api-gateway/src/index.mjs:17), which requires a `DATABASE_URL` not containing
"127.0.0.1"/"localhost"/"treasury_dev". Verified the IPv6-loopback workaround (`[::1]`, which the
local Postgres server itself accepts) does NOT work: this project's `pg` connection-string parser
fails on bracketed IPv6 (`getaddrinfo ENOTFOUND [::1]`) even though `pg.Client({host:"::1"})`
with discrete fields works fine — see session log below for the three options. Needs Flo's
decision before proceeding; not improvised. **Epic 0.2 done** (0.2.1–0.2.5, outbox DLQ / H3):
dead-lettering + exponential backoff on `platform.outbox_events`, watchdog alert, poison-batch
regression test. 0.2.6 (replay tool) deferred, P1. **Epic 0.3 done** (0.3.1–0.3.6,
`provider_submissions` crash-safety, G1, Finding 1 — CRITICAL): closes the duplicate-external-
transfer risk and the silent-Failed-with-lost-external-state bug (136/136 suite). Next: Epic 0.4
(config/auth/integrity hardening — 0.4.1/0.4.2 are P0). V6 close-out items (7.1, 7.2) may run in
parallel if they do not block
Phase 0. Task 5.3 (real rail) stays externally blocked until E1 custody partner + E2 secrets manager.

## Acceptance Criteria

Per-epic criteria are defined in `docs/V6_PLAN.md`. Blanket rule unchanged: every claim needs a
regression test, adversarial probe, DB invariant, or runbook; loop ends only with runtime proof.

## V8 Planning (product evolution)

Strategic pivot: governance/control plane → **settlement + treasury service** (SMB + corporate).
Full plan: `docs/V8_IMPLEMENTATION_PLAN.md` · task checklist: `docs/V8_TASK_LIST.md`.
**Phase 0 authorized** (2026-07-12): implement money-path safety before Phase 1 product work.
**Locked decisions:** see `docs/V8_FINAL_PLAN.md` §2 — sevdesk, Doppler (E2), Circle sandbox (E1), G1/G2/G4/G5 approved.
Phase 1 blocked on: Phase 0 exit + Doppler setup + Circle sandbox access.

## Active References

- `docs/V8_EXECUTION_INSTRUCTION.md` — **copy-paste prompt for another coding LLM**
- `docs/V8_FINAL_PLAN.md` — authoritative summary (decisions + phases + next steps)
- `docs/V8_IMPLEMENTATION_PLAN.md` — full epic/task specification
- `docs/V8_TASK_LIST.md` — stable task IDs and checkboxes for V8
- `HANDOFF.md` — full-state catch-up for anyone joining (aggregates audit, completion report, lessons)
- `docs/V6_JUDGE_INSTRUCTION.md` — prompt for an independent LLM to evaluate the work (blind verification, then grades the self-audit)
- `README.md`
- `TECHNICAL_TASKS.md`
- `docs/ARCHITECTURE.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/V5_VERIFIED_GAPS_TASK_LIST.md`
- `docs/V5_REMAINING_GAPS_FIX_INSTRUCTION.md`
- `docs/V6_PLAN.md`
- `docs/V6_TASK_LIST.md`
- `docs/V6_EXECUTION_INSTRUCTION.md`
- `docs/V6_REMAINING_TASKS_INSTRUCTION.md`

## Acceptance Criteria

Set task-specific criteria before coding.

Default criteria for hardening tasks:

- The reproduced failure has a regression or adversarial test.
- The implementation fixes the specific failure without weakening controls.
- Relevant tests pass.
- Documentation does not claim stronger behavior than the code provides.

## Last Completed Work

Epic 2.2 (row-level security) complete: tenant context via AsyncLocalStorage →
transaction-local `app.tenant_id`, RLS on all 8 schemas (migrations 0037–0044), 5
adversarial probes incl. a policy-drop bite test. Epic 2.1 verified and REPAIRED: the test
harness had a duplicate-key bug that kept all test stacks on the admin connection (roles
were never exercised by tests), plus a missing svc_gateway SELECT grant on platform.jobs
(0036). All 118 tests pass (49 unit + 65 integration + 4 concurrency). Remaining: 2.3,
Epic 5, 4.3, 7.1, 7.2, close-out.

## Session Log

```text
Date: 2026-07-06
Agent: Fable5
Task: Push to GitHub + CI repair
Files changed: committed ec64725 (V6 checkpoint, 98 files), f2d241d (CI triggers on master — workflow only fired on PRs before; branches was [main] but repo uses master), 5fe4ce6 (SERVICE_DB_PASSWORD mismatch fix + Dockerfile hardening + untrack infra/.terraform)
Tests run: local suite green pre-push; first-ever master-push CI run diagnosed: ALL integration tests failed at stack-ready timeout — svc_* role auth_failed because ci.yml set SERVICE_DB_PASSWORD=postgres while migration 0033 bakes 'service-dev-password' into the roles. KEY INSIGHT: local pg_hba is 'trust', so role passwords had NEVER been verified anywhere until this CI run. Trivy image-scan legitimately blocked on 14 HIGH CVEs (openssl base + npm's bundled deps) → fixed by apk upgrade + removing npm from the runtime image (services run plain node).
Result: pushed; CI re-run for 5fe4ce6 pending (monitor armed).
Next step: confirm CI green; then audit HIGH fixes (H1/H2/H3) or as directed.
Human decisions needed: None for the push; audit fixes still await authorization.
```

```text
Date: 2026-07-06
Agent: Fable5
Task: Simplification audit under new CLAUDE.md rules (applied)
Files changed: CLAUDE.md context applied; services/api-gateway/src/index.mjs (removed dead stateRefresh — zero callers, no-op branches), services/job-worker/src/index.mjs (orphan randomHex import), services/reconciliation-service/src/index.mjs (orphan enqueueJob import; local withInboxDedup removed), services/operations-service/src/index.mjs (local withInboxDedup removed), packages/shared/outbox.mjs (withInboxDedup consolidated here, single implementation), packages/shared/http.mjs (rateLimit option/limit shadowing renamed), db/migrations/0049_job_statement_grants.sql DELETED (no-op duplicate of 0047 grants with a false comment; uncommitted), db/migrations/0049_revoke_unused_job_grants.sql (revokes the unused 0047 svc_job statement grants — audit M3 partial)
Tests run: unused-import sweep clean, check (pass), test:all 125/125, migrate+dev+smoke (pass), 5 invariants all 0, verify-audit-chain ok, UI 200, logs clean
Result: PASS. Net: ~45 lines of dead/duplicated code removed, one dead-privilege migration deleted, one revoke added; zero behavior change (suite unchanged at 125). Codebase was otherwise clean (only 2 orphan imports project-wide). Deliberately NOT touched: per-test-file api/sleep helpers (churn > value), per-service sleep(), frontend sessionToken boolean-ification (belongs to audit M1 security fix), CANONICAL_HASH_SQL (single-implementation guarantee, not overengineering), planning docs (historical record). Interleaved-session note (corrected per human: agents run one at a time, Fable5 and Codex alternate — nothing parallel): a Codex session between this conversation's turns added 0048_tenant_scoped_statement_unique (legit fix, kept) and 0049_job_statement_grants (redundant re-grant of 0047, deleted). The collision happened because the next-free migration number was checked early in the session, not immediately before writing the file. Rule reinforced: re-run `ls db/migrations | tail` right before creating any migration — the check-migrations lint is the backstop and it worked.
Next step: audit HIGH fixes (H1+H2+M5 recommended as one session) or V6 close-out tasks; commit checkpoint still strongly advised (now ~85 files).
Human decisions needed: authorize audit fixes.
```

```text
Date: 2026-07-06
Agent: Fable5
Task: Whole-project audit (gaps and bugs) — docs/V6_AUDIT_REPORT.md
Files changed: docs/V6_AUDIT_REPORT.md (new), PROJECT_STATE.md
Tests run: baseline test:all 125/125 (findings are all uncovered-by-tests gaps); no fixes applied (audit only)
Result: 3 HIGH (ALLOW_DEMO_RESET documented but never enforced in code; demo reset is cross-tenant destructive — tenant-2 admin holds admin:reset and all reseeds hardcode tenant 1; outbox relay has no poison-event handling — recordDeliveryAttempt is a no-op, BATCH_SIZE=20 oldest-first starves on ≤20 failing events), 7 MEDIUM (session token in login body; auto-expiry+watchdog single-tenant; append-only eroded by blanket grants; breaker untested despite claim; SERVICE_DB_PASSWORD not gated; PRODUCTION_READINESS self-contradictory; Task 1.4 claimed but not implemented), 6 LOW. Cleared on inspection: webhook_events.status exists; statement enqueue transactional; __Host parsing; multi-tenant login intact.
Next step: human decides fix order (report suggests H1+H2+M5 as one hardening session, then H3, M1, M2).
Human decisions needed: authorize fixes (audit-only session by request); note L5 — 81 uncommitted files, commit checkpoint strongly advised.
```

```text
Date: 2026-07-05
Agent: Fable5
Task: Epic 5.2 — Provider statement ingestion and matching
Files changed: db/migrations/0047_provider_statements.sql (tables + explicit grants + RLS — GRANT ON ALL TABLES doesn't cover future tables), services/reconciliation-service/src/index.mjs (POST /statements ingest+dedupe+enqueue, POST /statements/:id/match matcher, GET /statements), services/reconciliation-service/src/seed.mjs (FK-ordered deletes), services/job-worker/src/index.mjs (match-statement handler via HTTP orchestration; SIMULATED_STATEMENT_EMIT flag-guarded emission after settle), scripts/ingest-statement.mjs (file-drop, signs internal auth), tests/integration/statements.test.mjs (3 E2E tests), docs/ENVIRONMENT.md, docs/V6_TASK_LIST.md, PROJECT_STATE.md
Tests run: statements 3/3, test:all 125/125 (49+72+4), check (pass), prod gate (pass), migrate+dev+smoke (pass), live file-drop ingestion probe (ingested + reset to clean demo state), 5 invariants all 0, verify-audit-chain ok, UI 200 + parses, logs clean
Result: PASS. Matching: exact provider_ref (confidence 1.00) reuses the existing Matched row (matched-once-per-payment index respected); categories amount_mismatch / fee_mismatch / duplicate / missing_ours; missing_theirs only when the statement declares a period. Matcher runs as a durable job orchestrating over HTTP (svc_job never touches reconciliation tables; svc_reconciliation never touches payment tables — payments fetched via serviceGet). Statement emission is OPT-IN (SIMULATED_STATEMENT_EMIT) because it changes recon counts; default off = zero behavior change. FK lesson applied: reseed deletes statement_lines → provider_statements before rows; probed via /api/reset in the E2E test AND live.
Next step: Task 4.3 (ADR-011), then 7.1, 7.2, V6 close-out.
Human decisions needed: ADR-011 content — OIDC in or out for pilot (recommendation on file: defer to V7 unless a design partner requires SSO).
```

```text
Date: 2026-07-05
Agent: Fable5
Task: Epic 2.2 — Row-level security (+ Epic 2.1 verification repair)
Files changed: packages/shared/db.mjs (ALS tenant context, tenant-aware query/withTransaction), packages/shared/http.mjs (context entry per request), packages/shared/audit.mjs (explicit tenant in chained insert), services/api-gateway/src/webhooks.mjs (explicit context post provider-resolution), services/*/src/seed.mjs (explicit tenant on 7 seeds), services/*/src/index.mjs (bootstrap wrapped in default-tenant context, 7 services), tests/helpers/stack.mjs (REPAIR: duplicate cwd/env keys silently discarded role URLs — all tests ran as admin), db/migrations/0036_gateway_jobs_select.sql (missing grant found once tests ran under real roles), db/migrations/0037–0044 (RLS per schema), tests/integration/rls.test.mjs (5 probes), docs/{ENVIRONMENT,RELEASE_CHECKLIST,V6_TASK_LIST}.md, PROJECT_STATE.md
Tests run: test:all after EVERY schema migration (8 × 113/113), final 118/118 (49+65+4), check (pass), prod gate (pass), migrate+dev+smoke (pass), 5 invariants all 0, verify-audit-chain ok (10 rows), UI 200 + parses, stack logs clean
Result: PASS. RLS fails closed (NULLIF-guarded current_setting), WITH CHECK blocks cross-tenant writes, wallet_balances VIEW fixed with security_invoker=true (a plain view executes with owner rights and would have silently bypassed RLS underneath — found because ENABLE RLS on a view errors), gateway provider-registry carve-out is SELECT-only and probed, bite test proves probes fail when a policy is dropped.
VERIFICATION REPAIR (Epic 2.1, previous session): stack.mjs spawn had duplicate cwd/env object keys — the second env (no role URL) won, so the "113 green under roles" claim was false for tests; only dev-stack smoke ran under roles. Fixing the harness immediately exposed the missing svc_gateway platform.jobs SELECT grant (enqueueJob RETURNING *) → 0036. Lesson recorded: after harness/env changes, verify the change is actually in effect (e.g. assert on the connected role), not just that tests stay green.
Residual risks: broad UPDATE/DELETE grants on append-only tables (audit_events, payment_events, payment_approvals, ledger) persist because the demo reset deletes in-band — tightening needs an owner-privileged reset path, backlog note. SERVICE_DB_PASSWORD default not rejected by the prod-config gate yet (checklist item added; gate extension is a small follow-up). RLS session-scoped follow-up: none.
Next step: Task 2.3 cross-tenant suite extension.
Human decisions needed: None.
```

```text
Date: 2026-07-05
Agent: Fable5
Task: Continuation instruction for remaining V6 tasks (docs/V6_REMAINING_TASKS_INSTRUCTION.md)
Files changed: docs/V6_REMAINING_TASKS_INSTRUCTION.md (new), PROJECT_STATE.md
Tests run: none (planning artifact; grant-inventory facts verified by grepping query( call sites)
Result: Instruction covers updated baseline (106 tests), remaining order (Epic 2 → Epic 5 → 4.3 → 7.1 → 7.2 → V6 close-out incl. V6_COMPLETION_REPORT.md), detailed Epic 2 guidance (cluster-wide roles, code-derived grant inventory incl. gateway→operations.audit_events INSERT+SELECT and job-worker cross-schema use, per-service DATABASE_URLs, RLS fail-closed pattern, BYPASSRLS for workers only, per-schema interaction tests), Epic 5 guidance (zero-behavior-change bar, FK/reset lesson), and 7 hard-won session lessons (smoke non-negotiable, stale-stack check, INSERT...SELECT casts, inbox FK, seed FK order, single canonical serialization, state upkeep).
Next step: Next agent executes Epic 2 Task 2.1 per the new instruction.
Human decisions needed: None (all gates approved). ADR-011 OIDC in/out will be recorded at Task 4.3.
```

```text
Date: 2026-07-05
Agent: Fable5
Task: Epic 3 — Tasks 3.1 (audit hash chain) + 3.2 (verifier, nightly job, runbook)
Files changed: db/migrations/0032_audit_hash_chain.sql (new), packages/shared/audit.mjs (new), scripts/verify-audit-chain.mjs (new), tests/integration/audit-chain.test.mjs (new, 4 tests), packages/shared/auth.mjs (emitSecurityAudit chained + loud fail-open log), services/operations-service/src/{index,seed}.mjs (chained inserts), services/job-worker/src/{index,scheduler}.mjs (audit-chain-verify job), services/payment-service/src/seed.mjs (REGRESSION FIX, see below), docs/{RUNBOOKS,RELEASE_CHECKLIST,ENVIRONMENT,V6_TASK_LIST}.md, PROJECT_STATE.md
Tests run: check (pass), test:all 106/106 (49+53+4), prod-config gate (pass), migrate+dev+smoke (pass), extended DB invariants incl. approval_rows_lt_count (all 0), verify-audit-chain (ok, exit 0), UI 200 + main.js parses, stack logs clean
Result: PASS. Chain: per-tenant sha256 links (canonical serialization lives ONLY in SQL — packages/shared/audit.mjs), advisory-lock-serialized appends, gapless chain_seq, backfill migration. Verifier detects tampering (row_hash_mismatch), relinking, interior deletion (sequence_gap); nightly job raises one deduped High alert and auto-closes on heal. Known limitation documented: chain truncation (newest rows) needs WORM anchoring (backlog 6.5).
REGRESSION FOUND+FIXED (Epic 1, previous session): payment-service /reset deleted payments without deleting payment_approvals rows → FK violation, every demo reset 500'd once a payment had approval rows (incl. policy:auto). Also reseeded payments carried approvals counts with zero approval rows → approvals-integrity invariant broke after every reset. Fixed in services/payment-service/src/seed.mjs (delete approvals first; seed matching seed:demo:n rows). Previous session's verification table had no smoke run — smoke would have caught this. Lesson: never skip the live smoke step.
Note: task list 3.1 suggested a JS unit test for serialization stability; not applicable — serialization exists only in SQL by design (single implementation), stability proven by tamper/restore integration test.
Next step: Epic 2 (2.1 roles → 2.2 RLS → 2.3 cross-tenant suite), schema-by-schema.
Human decisions needed: None.
```

```text
Date: 2026-07-04
Agent: opencode
Task: Epic 4 (4.1 cookie hardening, 4.2 security headers)
Files changed: packages/shared/auth.mjs (__Host- prefix, SESSION_IDLE_TTL, session rotation support via exported cookieName functions), packages/shared/http.mjs (CSP + X-Frame-Options in setBaseHeaders), services/api-gateway/src/index.mjs (session rotation in login, logout Max-Age=0 clearing, imported cookieName functions), apps/web/main.js (csrf cookie reads __Host-csrf + csrf), docs/ENVIRONMENT.md (new env vars documented, HSTS note), PROJECT_STATE.md, docs/V6_TASK_LIST.md (checkboxes)
Tests run: npm run check (pass), test (49 pass), test:integration (43 pass), test:concurrency (4 pass) — all 96 pass
Result: PASS. Cookies use __Host- prefix in secure mode. Login rotates sessions. Idle timeout bumps expires_at with grace window and absolute cap. Logout clears cookies client-side. CSP + X-Frame-Options added as base headers.
Next step: All unblocked tasks complete. Ask human for gate decisions A1-A6.
Human decisions needed: A1-A6 gate approvals to proceed.
```

```text
Date: 2026-07-04
Agent: opencode
Task: Epic 6 (6.1 money-path metrics, 6.2 watchdog, 6.3 log hygiene probe)
Files changed: services/relay-worker/src/index.mjs (outbox lag, unpublished count), services/job-worker/src/index.mjs (queue depth, DLQ, pending job age + ops-watchdog handler), services/job-worker/src/scheduler.mjs (watchdog scheduling), services/payment-service/src/index.mjs (payment state metrics, saga failures), packages/shared/http.mjs (extraMetrics option on createJsonService), services/api-gateway/src/index.mjs (webhook counters), services/api-gateway/src/webhooks.mjs (signature failure counter), tests/helpers/stack.mjs (logCaptureMax option), tests/integration/log-hygiene.test.mjs (new), PROJECT_STATE.md, docs/V6_TASK_LIST.md (checkboxes)
Tests run: npm run check (pass), test:all (96/96: 49+43+4 pass)
Result: PASS. Relay/job/payment/gateway /metrics now carry money-path data. Watchdog evaluates stuck payments, outbox lag, DLQ, pending job age; creates/clears alerts with dedup. Log hygiene probe confirms zero credential leaks.
Next step: Epic 4.1 (cookie hardening).
Human decisions needed: None for unblocked tasks.
```

```text
Date: 2026-07-04
Agent: opencode
Task: 0.4 — Prove CI green in GitHub Actions
Files changed: .github/workflows/ci.yml (DATABASE_ADMIN_URL at job level, DB_POOL_MAX=2, PGPASSWORD, TEST_STACK_READY_TIMEOUT_MS), tests/integration/auth-rbac.test.mjs (4 direct DB connections now use stack._env.DATABASE_URL with credentials), README.md (CI badge), PROJECT_STATE.md, docs/V6_TASK_LIST.md (checkboxes)
Tests run: CI green (49+42+4=95 pass). npm run check (pass locally).
Result: PASS. Merge-blocking CI is a demonstrated fact. Green run: https://github.com/notabanker/stablecoin-treasury/actions/runs/28715275147. Fix: test connections were passwordless (hardcoded postgres://127.0.0.1:5432/$db), worked with local trust auth but failed under CI's SCRAM auth.
Next step: Epic 6.1 (money-path metrics).
Human decisions needed: None for unblocked tasks.
```

```text
Date: 2026-07-04
Agent: opencode
Task: 0.3 — ADR-010: single-process rate limiting accepted for pilot
Files changed: docs/adr/ADR-010-single-process-rate-limiting.md (new), docs/ENVIRONMENT.md (+4 lines), PROJECT_STATE.md, docs/V6_TASK_LIST.md (checkboxes)
Tests run: npm run check (pass)
Result: Decision recorded. In-memory rate limiters accepted as a documented single-instance constraint. Revisit trigger: horizontal scaling (Epic 7). No code changes.
Next step: Task 0.4 (prove CI in GitHub Actions).
Human decisions needed: None.
```

```text
Date: 2026-07-04
Agent: opencode
Task: 0.1 — Rewrite PRODUCTION_READINESS.md to match delivered reality
Files changed: docs/PRODUCTION_READINESS.md (complete rewrite), PROJECT_STATE.md, docs/V6_TASK_LIST.md (checkboxes)
Tests run: npm run check (pass), test:all (95/95 pass)
Result: PASS. Document now inventories delivered M0–M5 capabilities with 16 test-file references and adversarial probe citations. Gap table maps G1–G12 to V6 epics. "Still Required" section scoped to genuine remainder. V6 readiness definitions included (Demo GO, Investor GO after 0/1/3/6, Production NO-GO).
Next step: Task 0.3 (ADR-010 rate limiting).
Human decisions needed: None for unblocked tasks.
```

```text
Date: 2026-07-04
Agent: Fable5
Task: V6 execution instruction for the next agent (docs/V6_EXECUTION_INSTRUCTION.md)
Files changed: docs/V6_EXECUTION_INSTRUCTION.md (new), PROJECT_STATE.md (V6 Gate Status section added)
Tests run: none (planning artifact)
Result: Self-contained agent instruction covering baseline, gate mechanics (status lives in PROJECT_STATE.md § V6 Gate Status), task selection protocol, repo/harness facts incl. seeded identities and tenant UUIDs, per-task workflow, exact verification-loop commands, session report format, and rules.
Next step: human flips gates in § V6 Gate Status; next agent starts per the instruction (Task 0.1/0.3/0.4 first).
Human decisions needed: A1–A6 gate approvals.
```

```text
Date: 2026-07-04
Agent: Fable5
Task: Detailed V6 task/subtask list (docs/V6_TASK_LIST.md)
Files changed: docs/V6_TASK_LIST.md (new), PROJECT_STATE.md
Tests run: none (planning artifact; grounded in the same code inspection as V6_PLAN.md)
Result: 24 tasks across 9 epics with stable IDs, checkbox subtasks, acceptance criteria, tests, adversarial repros, gate mapping, and an execution order.
Next step: human approves gates; agent starts Task 0.1/0.3/0.4 or Epic 6 per execution order.
Human decisions needed: A1–A6 (unchanged); OIDC in/out (ADR-011).
```

```text
Date: 2026-07-04
Agent: Fable5
Task: Plan V6 (docs/V6_PLAN.md)
Files changed: docs/V6_PLAN.md (new), PROJECT_STATE.md
Tests run: none (planning session; gap claims verified by direct code inspection/grep)
Result: V6 plan drafted — 8 epics + verification epic, sequenced, with human approval gates A1–A6.
Verified gaps at planning time: anonymous approvals counter (no payment_approvals table), no DB roles/RLS, no audit hash chain, no OIDC, simulated providers only, no statement ingestion, metrics-only observability, no IaC/secrets/WAF, stale PRODUCTION_READINESS.md, CI unproven in Actions.
Next step: human decides A1–A6; agent may start Epic 0 (0.1, 0.3, 0.4), Epic 4 (except OIDC), or Epic 6 without approvals.
Human decisions needed: A1 approvals schema+semantics, A2 roles/RLS, A3 audit hash columns, A4 csrf NOT NULL, A5 providers/adapter schema, A6 infra ADRs (secrets manager, IaC tool, runtime target), OIDC in/out for pilot.
```

```text
Date: 2026-07-04
Agent: Fable5
Task: Close remaining V5 gaps (docs/V5_REMAINING_GAPS_FIX_INSTRUCTION.md) — logout CSRF, null-CSRF sessions, tenant-scoped login audit, proxy-aware rate limiting, regression coverage
Files changed: packages/shared/auth.mjs, packages/shared/http.mjs, services/api-gateway/src/index.mjs, tests/helpers/stack.mjs, tests/unit/auth.test.mjs, tests/integration/auth-rbac.test.mjs, docs/ENVIRONMENT.md, docs/RELEASE_CHECKLIST.md, docs/V5_COMPLETION_REPORT.md
Tests run: npm run check (pass), test:all (95/95 pass), prod-config gate (pass), migrate+dev+smoke (pass), DB invariants (all 0), UI assets 200 + main.js parses
Result: PASS. All 8 required adversarial probes covered by integration tests.
Next step: next unverified gap or infrastructure productionization (secrets manager, WAF, managed Postgres, mTLS)
Human decisions needed: None. Note: identity.sessions.csrf_token left nullable (runtime-strict); NOT NULL migration deferred pending schema-change approval.
```

```text
Date: 2026-07-03
Agent: Fable5
Task: Epic 1.3 — Add internal auth adversarial integration test
Files changed: tests/integration/auth-rbac.test.mjs (+33 lines)
Tests run: test:all (90/90 pass), plus targeted `--test-name-pattern` run
Result: PASS. Unsigned direct calls → 401. Gateway calls → 200. Health → 200.
Next step: Epic 6 documentation updates or next unverified gap
Human decisions needed: None
```

## V6 Gate Status

Agents: a gate is approved only if it says APPROVED here (or the human approves it in the
current session prompt — then update this section immediately). See
`docs/V6_EXECUTION_INSTRUCTION.md` for the hard rule.

| Gate | Scope | Status |
|---|---|---|
| A1 | `payment.payment_approvals` + `payments.created_by` + approval semantics (Epic 1) | APPROVED |
| A2 | Per-service Postgres roles + RLS (Epic 2) | APPROVED |
| A3 | `audit_events` `row_hash`/`prev_hash` columns (Epic 3) | APPROVED |
| A4 | `sessions.csrf_token` backfill + NOT NULL (Task 0.2) | APPROVED |
| A5 | Adapter interface + `providers` columns (Epic 5) | APPROVED |
| A6 | Infra ADRs: secrets manager, IaC tool, runtime target; OIDC scope (Epic 7, 4.3, 5.3) | APPROVED |

## V8 Gate Status

| Gate | Scope | Status |
|---|---|---|
| G1 | `payment.provider_submissions` + crash-safe settlement semantics (Phase 0 Epic 0.3) | **APPROVED** (2026-07-12) |
| G2 | Tenant tier + feature flags (SMB shell) | **APPROVED** (2026-07-12) |
| G3 | Fiat accounts + unified ledger | PENDING (Phase 2) |
| G4 | Integrations schema + ERP OAuth (sevdesk) | **APPROVED** (2026-07-12) |
| G5 | Tiered KYC/AML (SMB onboarding) | **APPROVED** (2026-07-12) |
| G6 | API keys + machine auth | PENDING (Phase 1 end) |
| G7 | Fiat rail adapter | PENDING |
| G8 | Liquidity/yield | PENDING |
| G9 | Multi-jurisdiction + residency | PENDING |
| G10 | Embedded / white-label | PENDING |

## Known Issues / Watch Points

- Do not assume production readiness just because the demo flow works.
- Check for conflicts between completion docs and verified gap docs before making claims.
- Treat auth, RBAC, CSRF, tenant isolation, accounting, and payment execution as high-risk areas.

## Test Commands

- `npm run check`
- `npm run test`
- `npm run test:integration`
- `npm run test:concurrency`
- `npm run test:all`
- `npm run smoke`

## Human Approval Required Before

- Changing accounting rules or journal semantics
- Changing policy/compliance behavior
- Changing payment state-machine semantics
- Changing database schema or migrations
- Changing tenant isolation assumptions
- Changing auth/RBAC security policy
- Adding new regulated-finance assumptions
- Performing broad refactors

## Session Log

Add newest entries at the top.

```text
Date: 2026-07-12
Agent: Claude
Task: V8 Task 0.1.3 — admin:reset scope fix; investigated 0.1.4
Files changed: tests/integration/auth-rbac.test.mjs (+2 tests: "tenant-1 admin reset restores the Vega baseline and leaves tenant 2 unchanged" — symmetric mirror of the existing tenant-2 test, proves the tenant-1 direction too, including payment_reference_seq unchanged; "admin:reset is granted only to each tenant's Admin role, not broadened to a platform-operator role" — direct RBAC-surface query asserting exactly {tenant-1 Admin, tenant-2 Admin} hold admin:reset); docs/V8_TASK_LIST.md (0.1.3 ticked, 0.1.4 marked BLOCKED); PROJECT_STATE.md; HANDOFF.md
Tests run: narrow (both new tests) 2/2; npm run check pass (known 0017 dup only); npm run test:all 132/132 (53 unit + 75 integration + 4 concurrency, up from 130); production-shaped npm run check pass; migrate + dev health/ready + smoke pass; 5 DB invariants all 0 (incl. approvals-integrity, which the earlier session's 4-query block omitted); verify-audit-chain ok ({"ok":true,"checkedRows":10}); dev stack stopped cleanly after
Result: 0.1.3 PASS, no permission change made (per instruction and AGENTS.md auth/RBAC approval gate — this task was scoped as test-only from the start, matching Flo's 2026-07-12 decision recorded in the prior session). Decision I did NOT make unilaterally: whether admin:reset should ever move to a platform-operator role — explicitly out of scope per instruction.
0.1.4 investigation (no code changed, no test added — genuinely blocked): the adversarial "production mode + no ALLOW_DEMO_RESET -> 403" test needs a live gateway that (a) boots past validateProductionConfig (packages/shared/config.mjs:29, called synchronously at services/api-gateway/src/index.mjs:17 — throws and crashes boot on failure) and (b) has a real authenticated admin session, since isDemoResetAllowed() is checked inside perm("admin:reset") after login+RBAC, which need a live DB. validateProductionConfig rejects any DATABASE_URL containing "127.0.0.1", "localhost", or "treasury_dev" (config.mjs:47-51) — a pure string check, not a connectivity check. I tested the obvious workaround: pointing DATABASE_ADMIN_URL at the IPv6 loopback ([::1]) instead. The Postgres server itself accepts it (verified: psql "postgres://[::1]:5432/postgres" -c "select 1" succeeds, and node pg.Client({host:"::1",...}) succeeds), but this project's pg connection-string URI parser does not: pg.Client({connectionString:"postgres://[::1]:5432/postgres"}) fails with "getaddrinfo ENOTFOUND [::1]" (brackets included in the literal DNS lookup — a known pg-connection-string limitation with bracketed IPv6). Since tests/helpers/stack.mjs and every service build DATABASE_URL as a connection-string (never discrete host/port fields), this is a real dead end, not a mistake on my part.
Options for Flo (did not pick one — this is an infra/test-architecture decision, not a code fix):
  A) Point the test DB at genuinely non-local infrastructure (e.g. a Dockerized Postgres reachable by container hostname) — honest, but adds a new dependency to the test suite (Docker must be running).
  B) Add a narrow, explicitly-named test-only exception to validateProductionConfig's DB-locality check (e.g. recognizing the treasury_test_ prefix stack.mjs already uses for ephemeral DBs) — touches the production config gate itself, so needs sign-off even though it would be narrow; this is the kind of auth/production-policy change AGENTS.md reserves for Flo.
  C) Test only the route-wiring (perm("admin:reset") + isDemoResetAllowed() composition) at a level below full HTTP, skipping validateProductionConfig's DB check entirely — cheaper but weaker: HANDOFF.md/V8_EXECUTION_INSTRUCTION.md both ask specifically for an HTTP-level adversarial test, and 0.1.1's unit tests already cover isDemoResetAllowed() in isolation, so this would mostly re-test what 0.1.1 already proved rather than closing the real gap (route wiring under a live boot).
I did not attempt a numeric-shorthand IP trick (e.g. "127.1") to dodge the substring check — it would pass the string check while still literally being local dev infrastructure, which defeats the point of the check and would be exactly the kind of test-theater a later adversarial review (docs/V6_JUDGE_INSTRUCTION.md-style) would flag.
Next step: Flo picks A/B/C (or another option) for 0.1.4; then Epic 0.2 (outbox DLQ, H3).
Human decisions needed: 0.1.4 unblocker choice (A/B/C above).
```

```text
Date: 2026-07-12
Agent: Claude
Task: V8 Epic 0.2 — outbox DLQ / poison-event handling (audit finding H3)
Files changed: db/migrations/0050_outbox_dead_letter.sql (new: attempts, last_error, dead_lettered_at on platform.outbox_events; replaces the unpublished partial index to exclude dead-lettered rows), db/migrations/0051_outbox_backoff.sql (new: next_attempt_at, added after realizing 0.2.2 explicitly requires backoff, not just a counter), services/relay-worker/src/index.mjs (recordDeliveryAttempt now real: increments attempts, records last_error, dead-letters at RELAY_MAX_RETRIES — wiring up a constant that was declared but never used before this task — schedules exponential backoff otherwise; getUnpublishedEvents excludes dead-lettered and not-yet-eligible rows; /metrics gains deadLettered + deadLetterCount), services/job-worker/src/index.mjs (runWatchdog gains an "Outbox dead-letter queue non-empty" check, mirroring the existing platform.jobs DLQ check), tests/integration/outbox-dlq.test.mjs (new, 2 tests: 20-poison-event batch-starvation reproduction proving good events still deliver and the poison batch dead-letters instead of retrying forever; backoff-scheduling check), docs/RUNBOOKS.md (Outbox Delivery Failure section rewritten to match the new columns/remediation), docs/ENVIRONMENT.md (documents RELAY_MAX_RETRIES, previously undocumented dead code), docs/V8_TASK_LIST.md, PROJECT_STATE.md
Tests run: narrow (both new tests) 2/2 in isolation; npm run check pass (known 0017 dup only) x2 (after each migration); npm run test:all 134/134 (53 unit + 77 integration + 4 concurrency, up from 132) after both migrations applied; production-shaped npm run check pass; migrate + dev health/ready + smoke pass; all 5 DB invariants zero; verify-audit-chain ok; dev stack stopped cleanly
Result: PASS. H3 closed: reproduced the exact documented failure mode (20 permanently-failing events occupying the full BATCH_SIZE=20 LIMIT forever, starving delivery for everyone) and proved the fix — poison events dead-letter after RELAY_MAX_RETRIES attempts (default 5) and are excluded from future polls, freeing the queue for events behind them. First test-writing attempt hit the exact same long-lived-DB-probe-connection bug Codex documented in the 0.1.2 handoff (57P01 "terminating connection due to administrator command") — fixed by switching to short-lived per-query connections, matching the established pattern in auth-rbac.test.mjs. 0.2.6 (DLQ replay tool, P1) deliberately not built — not required for Phase 0 exit, no manual remediation path exists yet beyond the documented "clear dead_lettered_at, reset attempts=0" runbook step.
Next step: Epic 0.3 (provider_submissions crash-safety, G1 approved) is the next P0 work; 0.1.4 still needs Flo's A/B/C decision.
Human decisions needed: 0.1.4 unblocker choice (unchanged, still open).
```

```text
Date: 2026-07-12
Agent: Claude
Task: V8 Epic 0.3 — provider_submissions crash-safety (Gate G1, LLM_TECHNICAL_HANDOFF_OPEN_FINDINGS.md Finding 1, CRITICAL)
Files changed: db/migrations/0052_provider_submissions.sql (new: payment.provider_submissions -- tenant_id, payment_id (TEXT FK ON DELETE CASCADE), provider_id, idempotency_key, status, provider_ref, chain_ref, last_error, timestamps; UNIQUE(tenant_id,payment_id) + UNIQUE(tenant_id,provider_id,idempotency_key); RLS tenant_isolation policy; explicit SELECT/INSERT/UPDATE grants to svc_payment + svc_job since the 0033 blanket grant only covers tables that existed then), packages/shared/adapters/custody.mjs (SimulatedCustodyAdapter now honors request.idempotencyKey via an in-memory map, returning the same result on repeat calls instead of a fresh random ref; added CrashOnceThenIdempotentAdapter, a test-only double gated behind CUSTODY_TEST_CRASH_ADAPTER=true that records a transfer as provider-accepted then throws on its first call, mirroring a real ambiguous-outcome failure; FIXED a latent bug found while testing this -- resolveAdapter() called the registry factory fresh on every invocation, so adapter-held idempotency state was silently discarded across a crash+retry, which is two separate saga runs and thus two separate resolveAdapter() calls; adapter instances are now memoized per adapter key), services/job-worker/src/index.mjs (executePaymentSaga Step 2 rewritten: ensureProviderSubmission() inserts a pending row with idempotency_key=`payment:<id>` before calling the adapter; resumes from a submitted row's recorded provider_ref instead of re-calling the adapter when possible, otherwise resubmits with the SAME key; Step 3's catch block no longer marks the payment Failed on a ledger-debit failure, because by that point the provider has already accepted the transfer -- marking Failed would silently lose that external state, so the payment now stays Executing and surfaces on the existing GET /api/repair list), tests/integration/provider-crash-safety.test.mjs (new, 2 tests: crash-then-retry proves the retry reuses the deterministic idempotency key and settles with the SAME provider_ref rather than creating a new submission; debit-fails-after-provider-succeeds proves the payment stays Executing with provider_ref intact and appears on /repair rather than being silently marked Failed), docs/V8_TASK_LIST.md, PROJECT_STATE.md
Tests run: narrow (both new tests) 2/2 in isolation (first run of test 1 failed with a 15s timeout, root-caused to the resolveAdapter memoization bug above -- not a flake, a real design gap the test caught); npm run check pass (known 0017 dup only); npm run test:all 136/136 (53 unit + 79 integration + 4 concurrency, up from 134); production-shaped npm run check pass; migrate + dev health/ready + smoke pass; all 5 DB invariants zero; verify-audit-chain ok ({"ok":true,"checkedRows":10}); dev stack stopped cleanly
Result: PASS. Closes the CRITICAL finding (duplicate external transfer risk on crash/retry) and the second failure mode (provider-accepted-but-debit-failed silently marked Failed, losing external state). Deliberately did NOT add a new payment status (e.g. ProviderSubmitted/SettlementPending) -- reused the existing Executing status + GET /api/repair mechanism, which already exists and is already tested, keeping this change out of "new payment-state-machine semantics" territory per AGENTS.md's approval-gate list (G1's approved scope explicitly includes "crash-safe settlement semantics," which this satisfies without a state-machine change). Retry-safety relies on the SAME idempotency key being resubmitted to the provider on every attempt (not a "check status first" short-circuit for the ambiguous-throw case) -- this matches how real idempotent provider APIs (Stripe-style Idempotency-Key) are meant to be used and is the documented "reconcile by provider idempotency key" option from Finding 1, not a workaround.
Next step: Epic 0.4 (config/auth/integrity hardening: 0.4.1 SERVICE_DB_PASSWORD gate, 0.4.2 creator!=approver DB constraint are P0; rest P1/P2) is the next P0 work; 0.1.4 still needs Flo's A/B/C decision.
Human decisions needed: 0.1.4 unblocker choice (unchanged, still open). Session cost is now high (~$79) -- pausing here rather than auto-continuing to Epic 0.4.
```

```text
Date: 2026-07-12
Agent: Codex
Task: V8 Task 0.1.2 — tenant-scoped reseeds (audit H2)
Files changed: packages/shared/data.mjs (tenant-specific seed profiles: Vega, Nordic, empty fallback); all seven services/{wallet,policy,compliance,payment,accounting,operations,reconciliation}-service/src/{index,seed}.mjs (derive caller tenant from signed internal header and delete/reseed only that tenant); services/payment-service/src/seed.mjs (removed cross-tenant global sequence restart); tests/integration/auth-rbac.test.mjs (authenticated tenant-2 adversarial reset); tests/unit/config.test.mjs (unique import nonce repairs a proven prior-session config-test cache flake); docs/V8_TASK_LIST.md, PROJECT_STATE.md
Tests run: focused tenant-2 reset test 1/1; npm run check pass (known 0017 duplicate only); npm run test:all 130/130 (53 unit + 73 integration + 4 concurrency); production-shaped npm run check pass; migrate + dev health/ready + smoke pass; 5 DB invariants all 0; verify-audit-chain ok (9 rows, exit 0); git diff --check pass
Result: PASS. Tenant-2 admin reset restores the Nordic provider/entity/asset/wallet/balance/policy/counterparty/audit baseline, clears tenant-2 payments/journals/reconciliation (no approved fixtures), and leaves tenant-1 payment, wallet, and provider IDs unchanged. The test also proves payment_reference_seq is unchanged by reset. Unknown tenants receive an empty operational reset and never inherit Vega IDs. Identity/RBAC is deliberately untouched.
Repair feedback: first full suite attempt exposed Date.now()-based ESM cache-key collision in the 0.1.1 config tests; a monotonic import nonce fixed it and two consecutive unit runs passed before the full suite.
Next step: Task 0.1.3 — decide whether tenant-scoped admin:reset is sufficient or whether the permission should be restricted to a platform-operator role; this is an auth/RBAC policy decision requiring Flo approval. Then 0.1.4 production-mode HTTP adversarial test.
Human decisions needed: 0.1.3 permission policy (recommend keep tenant Admin permission because reset is now strictly tenant-scoped; add explicit RBAC regression rather than introduce a new platform-operator role in Phase 0).
```

```text
Date: 2026-07-12
Agent: opencode
Task: V8 Task 0.1.1 — ALLOW_DEMO_RESET production gate on POST /api/reset (audit H1)
Files changed: packages/shared/config.mjs (new isDemoResetAllowed() — fail-closed: reset allowed outside PRODUCTION_MODE, and in production only when ALLOW_DEMO_RESET==="true" exactly), services/api-gateway/src/index.mjs (import + 403 demo_reset_disabled gate at the top of the /api/reset handler, before tenant fan-out), tests/unit/config.test.mjs (+4 tests: dev allows, prod-unset blocks, prod non-"true" values block, prod "true" allows), docs/ENVIRONMENT.md (ALLOW_DEMO_RESET row now states exact prod-only semantics), docs/V8_TASK_LIST.md (0.1.1 ticked)
Tests run: check (pass, exit 0, known 0017 dup), test:all 129/129 (53 unit incl. +4 new + 72 integration + 4 concurrency), migrate + dev + smoke (pass — dev-mode reset still works, gate is prod-only), 5 DB invariants all 0, verify-audit-chain ok exit 0 (on a freshly recreated treasury_dev; see note), acceptance grep shows implementation sites in packages/ + services/
Result: PASS. TDD red→green: new unit tests failed with "isDemoResetAllowed is not a function", then passed after implementation. Gate is the falsifiable regression for H1. Design note: the full adversarial *HTTP* test (Task 0.1.4) can't boot a PRODUCTION_MODE gateway locally because validateProductionConfig correctly rejects a localhost/treasury_dev DATABASE_URL at boot — verified that exact boot rejection. So 0.1.1's regression lives at the config-decision layer (unit) + code wiring; 0.1.4 will need either a non-localhost test DB or a seam to exercise the gate over HTTP without a real prod DB. Did NOT touch reseed tenant-scoping — that is 0.1.2 (H2), deliberately left for the next task.
Environment note: treasury_dev carried a stale `TAMPERED` audit row (aud-nordic-seed-1, tenant-2, dated 2026-07-03) from an earlier session's tamper probe, which made verify-audit-chain exit 1 before I recreated the DB. It is dev-DB pollution, not a code regression (my diff touches no audit code; demo reset only reseeds tenant-1 so it never heals tenant-2). Recreated treasury_dev clean → chain verifies ok. Watch point for anyone reusing this dev DB.
Next step: Task 0.1.2 — parameterize all */seed.mjs reseeds by caller tenant_id (H2), then 0.1.3 admin:reset scope, then 0.1.4 adversarial test.
Human decisions needed: None (Phase 0 authorized; no gate needed for 0.1.1). Flag for 0.1.4: decide how to run the production-reset HTTP assertion given the localhost DB-URL prod-gate (test DB host vs. gate seam).
```

```text
Date: 2026-07-12
Agent: Grok
Task: V8 final plan published — all core decisions locked
Files changed: docs/V8_FINAL_PLAN.md (new), PROJECT_STATE.md
Tests run: none
Result: Final plan §2 locks sevdesk, Doppler, Circle, G1/G2/G4/G5; Phase 0→1→2→3 sequence + exit criteria + next steps
Next step: Engineering Epic 0.1; parallel Doppler + Circle sandbox + sevdesk dev app
Human decisions needed: Phase 2 only (E3 EMI, G3/G7, DATEV path)
```

```text
Date: 2026-07-12
Agent: Grok
Task: V8 implementation plan — settlement + treasury service (SMB → corporate)
Files changed: docs/V8_IMPLEMENTATION_PLAN.md (new), docs/V8_TASK_LIST.md (new), PROJECT_STATE.md
Tests run: none (planning docs only)
Result: Detailed phased plan (0–3) merging strategic pivot, V6/V7 audit findings, architecture, integrations, compliance, UX, GTM, competitive matrix, 24 user stories, 10 approval gates
Next step: Human review of plan; authorize Phase 0 (0.1–0.3 + G1 for provider_submissions); or begin V6 close-out items still open
Human decisions needed: Approve V8 scope; approve gates G1–G10 per epic; select Phase 1 accounting connector (Xero vs QBO); custody sandbox partner (E1)
```

Template:

```text
Date:
Agent:
Task:
Files changed:
Tests run:
Result:
Next step:
Human decisions needed:
```
