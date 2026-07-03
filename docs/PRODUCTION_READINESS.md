# Production Readiness

## Hardened In This Pass

- Durable per-service state in `DATA_DIR` with atomic JSON writes.
- Request IDs, structured logs, request body size limits, safer response headers, and JSON error handling.
- `/health`, `/ready`, and `/metrics` endpoints.
- Service-to-service timeouts and bounded retries for retry-safe reads.
- Idempotency keys for wallet debits and payment creation.
- Idempotent downstream journal and reconciliation writes by payment ID.
- Resumable payment execution from `Executing` state.
- Docker Compose health checks, restart policies, non-root container runtime, and persistent volume.
- Smoke test covering readiness, reset, idempotent payment creation, approval, execution, journal creation, reconciliation, and balance debit.

## Still Required Before Real Money

- Replace JSON stores with transactional databases per service.
- Add an event bus/outbox pattern for payment workflow events.
- Add authentication, SSO, RBAC enforcement, and tenant isolation at the API layer.
- Add secrets management and rotated provider credentials.
- Add real custody, bank, CASP, AML, FX, and ERP adapters with sandbox/prod separation.
- Add database migrations, backups, restore drills, and retention policies.
- Add signed webhook verification for provider callbacks.
- Add audit-log immutability using append-only storage or WORM retention.
- Add deployment IaC, TLS ingress, WAF/rate limits, and environment promotion.
- Add formal test suites: unit, contract, integration, load, security, and disaster-recovery tests.
- Complete legal, compliance, and DORA/ICT risk validation before production treasury use.

## Operational Commands

```bash
npm run check
npm run dev
npm run smoke
docker compose up --build
```

## Readiness Endpoints

- Gateway: `GET /ready`
- Any service: `GET /health`
- Any service: `GET /metrics`

