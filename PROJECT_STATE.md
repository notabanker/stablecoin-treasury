# PROJECT_STATE

This file is the live working memory for AI coding agents. Update it after each focused work session.

## Current Objective

Execute V6 ("From Hardened Demo to Operable Pilot") per `docs/V6_EXECUTION_INSTRUCTION.md`.
All approval gates A1–A6 are APPROVED (see § V6 Gate Status).

## Current Task

Epic 5.2 (statement ingestion + matching) complete. Remaining per
`docs/V6_REMAINING_TASKS_INSTRUCTION.md`: Task 4.3 (ADR-011 OIDC decision), Task 7.1
(container hardening, CI scan, env shapes, Terraform skeleton), Task 7.2 (external
tracker table in PRODUCTION_READINESS), V6 close-out (V6_COMPLETION_REPORT.md).
Task 5.3 (real rail) stays externally blocked.

## Acceptance Criteria

Per-epic criteria are defined in `docs/V6_PLAN.md`. Blanket rule unchanged: every claim needs a
regression test, adversarial probe, DB invariant, or runbook; loop ends only with runtime proof.

## Active References

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

