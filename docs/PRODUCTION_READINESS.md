# Production Readiness

## Hardened In This Pass

- Durable per-service state in Postgres (schema-per-service), replacing the earlier JSON-file
  store. See `docs/DATABASE.md`.
- Real database constraints doing work the application used to do alone: non-negative balances,
  a deferred trigger rejecting unbalanced journal batches at commit, unique idempotency keys,
  unique payment references backed by a sequence, and dedupe indexes closing two check-then-insert
  races found while porting (duplicate journal batches / duplicate reconciliation matches under
  concurrent calls).
- Concurrency correctness moved from in-process locks to the database: wallet debits are a single
  `UPDATE ... WHERE balance >= $1`, idempotency reservations are `INSERT ... ON CONFLICT`, and
  payment approve/execute/cancel use `SELECT ... FOR UPDATE`. All three hold up under genuine
  concurrent load in the test suite (`tests/concurrency/`), not just in a single process.
- Every table carries a real `tenant_id` from its first migration.
- Request IDs, structured logs, request body size limits, safer response headers, and JSON error
  handling.
- `/health`, `/ready` (now checks the database connection), and `/metrics` endpoints.
- Service-to-service timeouts and bounded retries for retry-safe reads.
- Idempotent downstream journal and reconciliation writes by payment ID.
- Resumable payment execution from `Executing` state.
- Docker Compose: Postgres with a persistent volume and healthcheck, a `db-migrate` one-shot job
  every service depends on, service health checks, restart policies, non-root container runtime,
  and only the gateway port published.
- Test suite: 40 unit tests (pure logic), 12 integration tests (full 8-service stack + direct
  DB-level concurrency tests), 4 concurrency tests (N-way parallel requests against a live stack).
  Smoke test covers the happy path plus four failure paths (blocked counterparty, over hard
  limit, review blocks approval, idempotency key reuse) and refuses to run against non-loopback
  hosts without an explicit override.

## Still Required Before Real Money

- Append-only double-entry ledger deriving wallet balances from immutable entries, instead of a
  mutable (if now well-constrained) `balance` column. (M2)
- A formal payment state machine with a DB-enforced transition table, not just a status
  vocabulary CHECK constraint. (M2)
- Move payment execution off a synchronous multi-service call chain onto a transactional
  outbox/saga so a downstream failure can't strand state across services. (M3)
- Per-service Postgres roles with `REVOKE`d cross-schema access (schemas are separated; role
  enforcement is not yet).
- Add authentication, SSO, RBAC enforcement, and tenant isolation at the API layer. (M4)
- Add secrets management and rotated provider credentials.
- Add real custody, bank, CASP, AML, FX, and ERP adapters with sandbox/prod separation. (M5)
- Add managed Postgres, PITR, backups, restore drills, and retention policies.
- Add signed webhook verification for provider callbacks. (M5)
- Add audit-log tamper-evidence (hash chain) beyond the current `REVOKE UPDATE, DELETE`. (M4)
- Add deployment IaC, TLS ingress, WAF/rate limits, and environment promotion. (M6)
- Add contract, load, and security test suites; CI gating on tests/lint/migration checks. (M6)
- Complete legal, compliance, and DORA/ICT risk validation before production treasury use.

See `docs/PRODUCTION_MVP_BACKLOG.md` for the full prioritized backlog this pass worked through.

## Operational Commands

```bash
npm run db:setup   # one-time: create treasury_dev/treasury_test, apply migrations
npm run check      # syntax check every .mjs file + apps/web/main.js
npm run dev        # start all 8 services against DATABASE_URL (defaults to treasury_dev)
npm run test       # unit tests (pure functions, no DB)
npm run test:integration  # full-stack + direct-DB tests against ephemeral Postgres databases
npm run test:concurrency  # N-way parallel request tests against a live stack
npm run smoke      # end-to-end smoke test against a running gateway (defaults to loopback:8080)
docker compose up --build
```

## Readiness Endpoints

- Gateway: `GET /ready`
- Any service: `GET /health`, `GET /ready` (checks its own DB connection), `GET /metrics`
