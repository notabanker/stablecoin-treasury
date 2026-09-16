# Contributing

## Setup

1. Clone the repository.
2. Run `npm install` (Node >= 20; only runtime dependency is `pg`).
3. Run `npm run db:setup` to create `treasury_dev`/`treasury_test` and apply migrations.
4. Run `npm run test:all` to verify the baseline is green.

## Development Loop

`AGENTS.md` has the full loop and the human-approval gates. In short:

1. Restate the task and acceptance criteria.
2. Inspect the code before editing; write a failing regression test when behavior changes.
3. Implement the smallest safe fix.
4. Run the narrowest useful check, then `npm run test:all`.
5. Update `PROJECT_STATE.md` with status, evidence, and next step.

## Code Style

- ESM-only (`"type": "module"`); no new runtime dependencies without an ADR.
- Use `packages/shared/` for cross-service utilities; money via `packages/shared/money.mjs`.
- Migrations in `db/migrations/` with sequential numeric prefixes; never edit applied ones.
- Tests live in `tests/{unit,integration,concurrency}/*.test.mjs` (`node:test`).

## Service Boundaries

- Each service owns its Postgres schema and reaches other domains only through HTTP.
- Service-to-service calls use HMAC-signed internal auth.
- Every tenant-scoped table is protected by RLS; tenant context comes from the request.

## Pull Requests

- One concern per PR; add or update tests for changed behavior.
- `npm run check` and `npm run test:all` must pass.
- Update `CHANGELOG.md` for notable changes.
- Never commit secrets; never weaken controls to make tests pass.
