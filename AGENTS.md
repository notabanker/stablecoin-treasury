# AGENTS.md

Project-specific instructions for coding agents working on the corporate stablecoin treasury platform.

## Start Here

Before coding, read these files in this order:

1. `PROJECT_STATE.md`
2. `docs/AGENT_LOOP.md`
3. `README.md`
4. `TECHNICAL_TASKS.md` or the relevant `docs/*.md` task file for the current work

Treat `PROJECT_STATE.md` as the current source of truth for the active task, open questions, acceptance criteria, and last known test results.

## Project Context

This is a development-stage corporate stablecoin treasury platform for EU corporate treasury workflows. It covers wallet balances, policy-governed payments, four-eyes approvals, reconciliation, accounting journals, operations, auditability, and production-hardening checks.

This is not production money-movement infrastructure yet. Do not claim production readiness unless the project's own readiness docs, tests, and Flo's approval support that claim.

## Development Loop

For every task:

1. Restate the active task and acceptance criteria.
2. Inspect the relevant files before editing.
3. Make a small implementation plan.
4. Implement one focused subtask.
5. Run the narrowest useful verification command.
6. Use failures, logs, and test output as feedback.
7. Repair only what the feedback proves is broken.
8. Repeat up to 3 repair attempts.
9. Update `PROJECT_STATE.md` with changes, tests, and next step.
10. Stop when acceptance criteria pass or human judgment is needed.

## Verification Commands

Use the smallest relevant check first:

- Syntax/config/migration checks: `npm run check`
- Unit tests: `npm run test`
- Integration tests: `npm run test:integration`
- Concurrency tests: `npm run test:concurrency`
- Full automated suite: `npm run test:all`
- Smoke test against a live local stack: `npm run smoke`
- Local stack: `npm run dev`
- Database setup: `npm run db:setup`

## Human Approval Required Before

Stop and ask Flo before making changes that affect:

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

- Prefer small, reviewable changes.
- Preserve existing architecture and service boundaries.
- Do not invent regulated-finance behavior without explicit approval.
- Do not loosen controls to make tests pass.
- Add or update regression tests for security, accounting, payment, reconciliation, and tenant-isolation behavior.
- Keep documentation aligned with actual code behavior.

