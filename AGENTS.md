# AGENTS.md

Project instructions for coding agents working on the corporate stablecoin treasury platform.

## Start Here

Read in order before changing anything:

1. [PROJECT_STATE.md](PROJECT_STATE.md) — current state of truth: status, gaps, next work.
2. `AGENTS.md` (this file) — workflow, gates, coding rules.
3. [TECHNICAL_TASKS.md](TECHNICAL_TASKS.md) — the live backlog.
4. The code you will touch — code wins over docs.

## Project Context

Development-stage MiCA-oriented treasury platform: wallet balances, policy-governed payments,
four-eyes approvals, double-entry ledger, reconciliation, accounting journals, operations,
and tamper-evident audit. Not production money-movement infrastructure — do not claim
production readiness, live settlement, or licensing the project does not have.

## Development Loop

1. Restate the task and acceptance criteria.
2. Inspect the relevant files before editing.
3. Write or extend a failing regression/adversarial test when behavior changes.
4. Make the smallest safe fix, matching existing patterns.
5. Run the narrowest useful check, then widen to the full loop.
6. Repair only what the feedback proves is broken; max 3 attempts, then stop and report.
7. Update `PROJECT_STATE.md` (status, evidence, next step) before finishing.

## Verification Commands

Smallest first:

- `npm run check` — syntax, migration lint, prod-config gate
- `npm run test` — unit; `npm run test:integration`; `npm run test:concurrency`
- `npm run test:all` — required before declaring any task done
- `npm run invariants` — DB invariants, all zero (see `docs/RUNBOOKS.md`)
- `npm run smoke` — happy path + failure paths against a live local stack
- `npm run db:setup`, `npm run migrate`, `npm run dev`

## Human Approval Required Before

Stop and ask Flo before changes affecting:

- Accounting rules or journal semantics
- Policy/compliance behavior
- Payment state-machine semantics
- Database schema or migrations
- Tenant isolation assumptions
- Auth/RBAC security policy
- Provider/custody assumptions
- Product scope or regulated-finance claims
- Large refactors outside the active task

## Coding Rules

- Prefer small, reviewable changes; preserve service boundaries.
- Do not loosen controls to make tests pass; never hide uncertainty.
- Never commit secrets; never log credentials, tokens, or connection strings.
- Add or update regression tests for security, accounting, payment, reconciliation, and
  tenant-isolation behavior.
- Money paths use `packages/shared/money.mjs`; no bare `Number()` on amount/fee/balance.
- Keep docs claiming exactly what the tests prove.

## Stop Conditions

Stop and report when: acceptance criteria are unclear; a fix requires changing gated
semantics; the same failure survives 3 repair attempts; you find conflicting docs; the work
would become a broad refactor.
