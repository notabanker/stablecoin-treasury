# Architecture

## Shape

One PostgreSQL database (schema per service), one public API gateway/BFF, seven domain
services, two background workers, and a gateway-served vanilla-JS frontend.

```text
Browser ──> api-gateway :8080 ──> wallet :4101
   (web UI,        │              policy :4102
    /api/*)        │              compliance :4103
                   │              payment :4104 ──> job-worker :9102 (saga)
                   │              accounting :4105        │
                   │              reconciliation :4106    │
                   │              operations :4107        │
                   │                                     ▼
                   └──────────── relay-worker :9101 ──> internal service endpoints
                                   (platform.outbox_events)
```

## Services

| Service | Port | Responsibility |
|---|---|---|
| api-gateway | 8080 | Serves `apps/web`, composes `/api/state`, auth/RBAC, webhook ingress, payment commands |
| wallet-service | 4101 | Legal entities, assets, wallets, ledger postings and balances |
| policy-service | 4102 | Thresholds, allowlists, payment policy evaluation |
| compliance-service | 4103 | Counterparties; screening is simulated from seeded status |
| payment-service | 4104 | Payment lifecycle, approvals, idempotency, repair/attempts |
| accounting-service | 4105 | Journal entries, balance assertion, export status |
| reconciliation-service | 4106 | Statement ingestion/matching, matches, exceptions |
| operations-service | 4107 | Providers, alerts, append-only audit events |
| relay-worker | 9101 | Polls `platform.outbox_events`, delivers to consumers |
| job-worker | 9102 | Durable jobs: payment saga, expiry, watchdog, audit-chain verify, webhooks |

## Request Flows

**Browser read:** `GET /api/state` → gateway fans out to domain services in parallel →
each failing slice degrades to an empty collection + `degraded` entry → one JSON payload.

**Payment command:** browser → gateway (auth + permission + idempotency key) → signed
internal call → payment-service (DB-enforced transition, `payment_events`, outbox event) →
gateway returns the command result plus fresh state.

**Payment execution saga:** `POST /api/payments/:id/execute` → payment `Executing` + job
enqueued → job-worker claims and runs: final policy check → provider submission
(`provider_submissions` row with a deterministic idempotency key before the external call)
→ wallet ledger debit → accounting journal → reconciliation match → `Settled`. Failures are
retried with backoff and dead-lettered; stuck `Executing` payments surface on `GET /api/repair`.

**Outbox relay:** domain services write `platform.outbox_events` in the same transaction as
the state change → relay-worker polls unpublished events, delivers over signed HTTP →
consumers dedupe via `platform.inbox_events` (at-least-once delivery, once-per-consumer
effect) → failed deliveries back off, then dead-letter and raise a watchdog alert.

**Webhooks:** provider → `POST /api/webhooks/:providerId` on the gateway → HMAC-SHA256
signature verified over the exact raw request body → provider registry resolves the tenant →
event deduped in `platform.webhook_events` → settlement webhook drives the saga.

## Shared Modules (`packages/shared/`)

| Module | Purpose |
|---|---|
| `http.mjs` | `createJsonService`: routing, static files, rate limiting, body limits, internal HMAC auth, metrics, security headers, graceful shutdown |
| `service.mjs` | `createDomainService`: `/health`, `/ready`, `/reset`, tenant-context injection, boot seeding |
| `worker.mjs` | Worker health server + poll loop used by both workers |
| `auth.mjs` | Sessions, login rate limit/lockout, scrypt passwords, CSRF, RBAC helpers |
| `db.mjs` | `pg` pools, `withTransaction`, AsyncLocalStorage tenant context for RLS |
| `tenant.mjs` | Tenant header resolution, `DEFAULT_TENANT_ID` |
| `money.mjs` | Cent-exact `Money` helpers; no bare `Number()` on money fields |
| `payment.mjs` | Payment row mapper + context fetch |
| `policy-math.mjs` | `ratesToEur`, `valueToEur`, `requiredApprovalsFor` |
| `data.mjs` + `seed-data.json` | Demo fixtures and seed profiles (Vega, Nordic, empty) |
| `jobs.mjs` | Durable job queue (claim/complete/fail with attempts and backoff) |
| `outbox.mjs` | Outbox event routes + inbox dedup helper |
| `audit.mjs` | Tamper-evident hash-chain insert and verifier |
| `metrics.mjs`, `log.mjs`, `rows.mjs` | Metrics registry, structured logging/redaction, row mappers |
| `config.mjs` | Production config gate, `isDemoResetAllowed()` |
| `service-client.mjs` | Signed service-to-service HTTP with timeouts/retries |
| `adapters/custody.mjs` | Custody adapter interface, simulated provider, circuit breaker |

## Adding A Service Or Route

**New route:** add it to the service's `routes` array (`route("POST", "/path", handler)`),
then expose it at the gateway with an auth/permission wrapper if browser-facing, and add a
view/action in `apps/web/js/views-*.js`. Add a regression test under `tests/integration/`.

**New service:** copy the shape of an existing service (`src/index.mjs` built on
`createDomainService`), own a new Postgres schema + migration, add its port to
`scripts/dev.mjs` and `docker-compose.yml`, add its URL to `service-client.mjs` and
`.env.example`, and give it explicit grants/RLS in a migration.
