# Corporate Stablecoin Treasury Platform

Development-stage, MiCA-oriented corporate stablecoin treasury platform for EU corporate
treasury workflows: wallet balances, policy-governed payments with four-eyes approvals,
double-entry ledger and journals, reconciliation, operations, and tamper-evident audit.

**Status: development-stage. Production money movement is NO-GO.** Settlement is simulated
behind a custody-adapter seam; real rails, secrets management, and production infrastructure
are not in place. See `docs/PRODUCTION_READINESS.md`.

## Run

Requires local PostgreSQL and Node >= 20.

```bash
npm install
npm run db:setup   # create treasury_dev/treasury_test and apply migrations
npm run dev        # start all services (gateway: http://127.0.0.1:8080)
```

Other commands: `npm run check` · `npm run test` · `npm run test:integration` ·
`npm run test:concurrency` · `npm run test:all` · `npm run invariants` · `npm run smoke` ·
`npm run migrate` · `docker compose up --build`.

## Services

| Service | Port | Owns |
|---|---|---|
| api-gateway | 8080 | BFF, web UI, auth/RBAC, webhooks |
| wallet-service | 4101 | entities, assets, wallets, ledger |
| policy-service | 4102 | approval thresholds, allowlists, evaluation |
| compliance-service | 4103 | counterparties (simulated screening) |
| payment-service | 4104 | payment lifecycle, approvals, idempotency |
| accounting-service | 4105 | journal entries, exports |
| reconciliation-service | 4106 | matches, exceptions, provider statements |
| operations-service | 4107 | providers, alerts, audit events |
| relay-worker | 9101 | outbox event relay |
| job-worker | 9102 | durable jobs (saga, expiry, watchdog, audit chain) |

## Documentation

- [PROJECT_STATE.md](PROJECT_STATE.md) — current state of truth, gaps, next work.
- [TECHNICAL_TASKS.md](TECHNICAL_TASKS.md) — live backlog.
- [AGENTS.md](AGENTS.md) — workflow and approval gates for coding agents; [CONTRIBUTING.md](CONTRIBUTING.md) for humans.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — service map, request flows, shared module map.
- [docs/DATABASE.md](docs/DATABASE.md) — schemas, migration policy, RLS, reset/seed.
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — environment variables and defaults.
- [docs/RUNBOOKS.md](docs/RUNBOOKS.md) — operational procedures.
- [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) — what is hardened, what is missing.
- [docs/ONBOARDING.md](docs/ONBOARDING.md) — setup and repo tour.
- [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) — pre-deploy checks.
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md), [docs/CREDENTIAL_ROTATION.md](docs/CREDENTIAL_ROTATION.md) — operations references.
- [docs/HISTORY.md](docs/HISTORY.md) — dated record of audits, releases, and refactors.
- [docs/adr/](docs/adr/) — architecture decision records.
