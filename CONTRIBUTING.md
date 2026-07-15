# Contributing

## Getting Started

1. Clone the repository.
2. Run `npm install`.
3. Run `npm run db:setup` to create local databases and apply migrations.
4. Run `npm run test:all` to verify everything passes.

## Development Loop

1. Restate the active task and acceptance criteria.
2. Inspect the relevant files before editing.
3. Make a small implementation plan.
4. Implement one focused subtask.
5. Run the narrowest useful verification command.
6. Use failures, logs, and test output as feedback.
7. Repair only what the feedback proves is broken.
8. Repeat up to 3 repair attempts.
9. Update `PROJECT_STATE.md` with changes, tests, and next step.

See `AGENTS.md` for the full development loop and coding rules.

## Code Style

- ESM-only (`"type": "module"`), Node >= 20.
- No runtime dependencies except `pg`.
- Use `packages/shared/` for cross-service utilities.
- Database migrations in `db/migrations/` with sequential numeric prefixes.
- Test files follow `tests/{unit,integration,concurrency}/*.test.mjs`.

## Service Boundaries

- Each service owns its Postgres schema and may read other schemas only through the API gateway.
- Service-to-service calls use HMAC-signed internal auth.
- Tenants are isolated by `tenant_id` on every table, enforced by RLS at the database level.

## Testing

- Unit tests: `npm run test` (pure logic, no DB required).
- Integration tests: `npm run test:integration` (full stack against ephemeral DBs).
- Concurrency tests: `npm run test:concurrency` (N-way parallel requests).
- Smoke tests: `npm run smoke` (against running gateway).

## Pull Requests

- Keep changes focused on a single concern.
- Add or update tests for the changed behavior.
- Ensure all tests pass: `npm run test:all`.
- Update `CHANGELOG.md` with notable changes.
- Tag with the relevant audit finding ID (e.g., `H1`, `M5`) where applicable.
