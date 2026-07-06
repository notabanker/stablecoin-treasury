# Corporate Stablecoin Treasury Platform

[![CI](https://github.com/notabanker/stablecoin-treasury/actions/workflows/ci.yml/badge.svg)](https://github.com/notabanker/stablecoin-treasury/actions/workflows/ci.yml)

Technology-only project folder for a MiCA-aligned corporate stablecoin treasury platform.

## Files

- `apps/web/` - gateway-served treasury operations UI.
- `services/` - independently runnable microservices.
- `packages/shared/` - shared HTTP helper, seed data, and service client.
- `docker-compose.yml` - local container orchestration.
- `docs/ARCHITECTURE.md` - service map and design notes.
- `docs/PRODUCTION_READINESS.md` - reliability status and remaining production gaps.
- `docs/V3_PLAN.md` - V3 secure pilot foundation plan with milestones, tasks, and release gates.
- `TECHNICAL_TASKS.md` - technology task and subtask backlog for MVP and later phases.

## Product Focus

Build a corporate-grade treasury SaaS platform that lets EU mid-to-large corporates hold, move, convert, reconcile, and report stablecoin balances through regulated partners, with strong controls, auditability, ERP/TMS integration, and policy enforcement.

## Run

Requires a local Postgres instance (`postgres://127.0.0.1:5432` by default). One-time setup:

```bash
npm run db:setup
```

Then run the microservices stack:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:8080
```

The gateway serves `apps/web` and exposes `/api/state`, `/api/docs`, and command endpoints for payments, policies, reconciliation, operations, and accounting.

## MVP Prototype Includes

- Treasury desk dashboard with wallet balances, issuer exposure, provider health, alerts, and payment queue.
- Payment creation, approval, cancellation, execution, policy checks, and settlement simulation.
- Wallet and asset registry with custody-provider coverage.
- Policy thresholds and asset allowlist controls.
- Reconciliation exceptions with manual resolution.
- Journal-entry generation and CSV export.
- Operations console for provider status and audit events.

## Services

- `api-gateway` on `8080`
- `wallet-service` on `4101`
- `policy-service` on `4102`
- `compliance-service` on `4103`
- `payment-service` on `4104`
- `accounting-service` on `4105`
- `reconciliation-service` on `4106`
- `operations-service` on `4107`

## Docker

```bash
docker compose up --build
```

## Reliability

This version includes durable service-local state, idempotent wallet debits, idempotent payment creation, service health checks, request timeouts, structured logs, `/metrics`, graceful shutdown, Docker health checks, and a smoke test.

Run:

```bash
npm run smoke
```

See [PRODUCTION_READINESS.md](/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/PRODUCTION_READINESS.md) for what is hardened and what still needs to happen before real regulated treasury use.
