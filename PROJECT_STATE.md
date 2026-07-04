# PROJECT_STATE

This file is the live working memory for AI coding agents. Update it after each focused work session.

## Current Objective

Continue V5 development hardening for the corporate stablecoin treasury platform.

## Current Task

V6 planned (`docs/V6_PLAN.md`) with a detailed task/subtask breakdown (`docs/V6_TASK_LIST.md`).
Awaiting human decisions on approval gates A1–A6 (approvals schema, RLS/roles, audit hash
columns, csrf NOT NULL, adapter/providers schema, infra ADRs). Unblocked-by-default starting
points per the task list's execution order: Tasks 0.1/0.3/0.4, then Epic 6, then Epic 4 (except 4.3).

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

## Acceptance Criteria

Set task-specific criteria before coding.

Default criteria for hardening tasks:

- The reproduced failure has a regression or adversarial test.
- The implementation fixes the specific failure without weakening controls.
- Relevant tests pass.
- Documentation does not claim stronger behavior than the code provides.

## Last Completed Work

- Closed all five remaining verified V5 security gaps with fixes + regression tests.
- Fixed a regression introduced mid-work: `authenticateUser` must match password across all
  candidate rows because emails are only unique per tenant (`UNIQUE (tenant_id, email)`).
- Added `x-csrf-token` to `Access-Control-Allow-Headers` (CSRF header is now mandatory for cookie mutations).
- Documented: unknown-email audit fallback, `TRUST_PROXY_HEADERS`, why `csrf_token` stays nullable.
- All 95 tests pass (49 unit + 42 integration + 4 concurrency); smoke + DB invariants clean.

## Session Log

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
| A1 | `payment.payment_approvals` + `payments.created_by` + approval semantics (Epic 1) | NOT APPROVED |
| A2 | Per-service Postgres roles + RLS (Epic 2) | NOT APPROVED |
| A3 | `audit_events` `row_hash`/`prev_hash` columns (Epic 3) | NOT APPROVED |
| A4 | `sessions.csrf_token` backfill + NOT NULL (Task 0.2) | NOT APPROVED |
| A5 | Adapter interface + `providers` columns (Epic 5) | NOT APPROVED |
| A6 | Infra ADRs: secrets manager, IaC tool, runtime target; OIDC scope (Epic 7, 4.3, 5.3) | NOT APPROVED |

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

