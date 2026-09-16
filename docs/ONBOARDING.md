# Onboarding

## Setup

1. Install Node >= 20 and a local PostgreSQL.
2. `npm install`
3. `npm run db:setup` — creates `treasury_dev` and `treasury_test` and applies all migrations.
4. `npm run dev` — starts all ten services on loopback; gateway at `http://127.0.0.1:8080`.
5. Log in with the seeded demo users (password `demo123`):
   - `marta@vega-industries.com` — tenant 1 (Vega) admin
   - `approver@vega-industries.com` — tenant 1 approver
   - `admin@nordic-holdings.com` — tenant 2 (Nordic) admin

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Run the full local stack |
| `npm run check` | Syntax check, migration lint, production-config gate |
| `npm run test` / `test:integration` / `test:concurrency` / `test:all` | Test suites (`node:test`) |
| `npm run invariants` | Live DB invariant checks (exit 0 when clean) |
| `npm run smoke` | End-to-end smoke against a running gateway (resets demo data) |
| `npm run db:setup` / `npm run migrate` | Create databases / apply migrations |
| `docker compose up --build` | Containerized stack (gateway published only) |

## Repo Tour

```text
apps/web/            gateway-served vanilla-JS UI
  index.html         single page; loads main.js as a module
  main.js            bootstrap
  js/state.js        client state
  js/api.js          fetch wrappers
  js/util.js         render helpers (table/panel/listCard), formatting, escaping
  js/views-*.js      overview/payments/wallets/ops views
packages/shared/     runtime + domain helpers shared by services and workers
services/            one directory per service (see docs/ARCHITECTURE.md)
db/migrations/       ordered SQL migrations (append-only history)
db/scripts/          migrate.mjs, setup.mjs
tests/               unit/, integration/, concurrency/, helpers/
scripts/             dev, smoke, invariants, migration/syntax checks, repair, verify-audit-chain
infra/               Terraform skeleton — nothing provisioned
docs/                architecture, database, environment, runbooks, ADRs, history
```

## Reading Order

1. [README.md](../README.md) and [PROJECT_STATE.md](../PROJECT_STATE.md) — what the platform is and where it stands.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — services, request flows, shared modules.
3. [DATABASE.md](DATABASE.md) — schemas, ledger, migrations, RLS.
4. `services/api-gateway/src/index.mjs` — routing, auth, BFF composition.
5. `packages/shared/service.mjs` and `http.mjs` — the runtime every service uses.
6. `services/job-worker/src/` — the payment saga and scheduled jobs.
7. `tests/integration/payment-lifecycle.test.mjs` — the end-to-end money path.

## Key Concepts

- **Tenant isolation:** tenant comes from the session at the gateway; RLS fails closed at
  the database; cross-tenant access is a 404.
- **Money correctness:** cent-exact `Money` helpers, append-only double-entry ledger,
  DB-enforced payment state machine, idempotency keys on every money-moving command.
- **Async safety:** side effects go through the transactional outbox; execution runs as a
  durable, resumable saga; poison events dead-letter with alerts.
- **Audit:** every sensitive action lands in a per-tenant hash chain; the nightly verifier
  detects edits, relinks, and interior deletions.

## Working In The Repo

Follow `AGENTS.md`: inspect first, test-first for behavior changes, run `npm run test:all`
before declaring done, and stop for human approval on schema, payment semantics,
accounting, policy, tenant-isolation, auth/RBAC, or provider changes.

## Troubleshooting

- `EADDRINUSE` on 8080 → a stale stack is running; `lsof -nP -iTCP:8080 -sTCP:LISTEN` and stop it.
- Integration tests fail to boot → check `tests/helpers/stack.mjs` output (it captures child logs).
- Audit verifier reports `TAMPERED` on a reused dev DB → recreate `treasury_dev` or run
  `npm run smoke` to restore the demo baseline.
- Demo data looks wrong → `POST /api/reset` as an admin (local/dev only).
