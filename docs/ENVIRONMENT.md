# Environment Configuration

## Core

| Variable | Default | Purpose |
|---|---|---|
| `PRODUCTION_MODE` | unset | `"true"` enables the production config gate on every service |
| `NODE_ENV` | unset | `"production"` required by the gate |
| `PORT` / `GATEWAY_PORT` | 4101–4107 / 8080 | Service listen port |
| `HOST` | `127.0.0.1` | Bind address in dev; compose binds container-wide |
| `DATABASE_URL` | `postgres://127.0.0.1:5432/treasury_dev` | Service connection (role-scoped per service) |
| `DATABASE_ADMIN_URL` | `postgres://127.0.0.1:5432/postgres` | Migrations/setup only |
| `SERVICE_DB_PASSWORD` | `service-dev-password` | Password for `svc_*` roles; must not be the default in production |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | `10`, `5000` | Pool and statement limits |
| `HTTP_BODY_LIMIT_BYTES` | `1048576` | Request body cap |

## Auth, Sessions, Tenancy

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_REQUIRED` | off | Enforce authentication at the gateway |
| `INTERNAL_AUTH_REQUIRED` | off | Require HMAC-signed service-to-service requests |
| `INTERNAL_SERVICE_TOKEN` | `dev-internal-token` | Shared internal HMAC secret (must be overridden in production) |
| `SESSION_COOKIE_SECURE` | off | `Secure` + `__Host-` cookie prefix |
| `SESSION_IDLE_TTL_MINUTES` | `0` (disabled) | Idle timeout; bumps `expires_at` at most once per minute |
| `SESSION_ABSOLUTE_TTL_HOURS` | `24` | Absolute session lifetime cap |
| `TENANT_HEADER_REQUIRED` | unset | `"true"`: missing `X-Tenant-Id` → `400 tenant_required` on non-public routes |
| `ALLOW_DEMO_RESET` | unset | In production, reset works only when exactly `"true"`; otherwise `403 demo_reset_disabled` |

## Rate Limiting And Proxies

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `1000` / `200` | General per-IP token bucket |
| `STATE_RATE_LIMIT_MAX` | `50` | `/api/state` bucket |
| `LOGIN_RATE_LIMIT_WINDOW_MS` / `LOGIN_RATE_LIMIT_MAX` / `LOGIN_LOCKOUT_MS` | `60000` / `5` / `300000` | Login failure window, max failures, lockout duration |
| `TRUST_PROXY_HEADERS` | unset | Honor `X-Forwarded-For` for the canonical client IP; set only behind a trusted proxy |

Rate limiters and login lockout are per-process in-memory (`Map`) — reset on restart and
not shared across replicas (ADR-010). `GET /health` bypasses rate limiting.

## Service Calls And Workers

| Variable | Default | Purpose |
|---|---|---|
| `SERVICE_TIMEOUT_MS` / `SERVICE_RETRIES` | `2500` / `2` | Internal call timeout and retries |
| `PAYMENT_MUTATION_TIMEOUT_MS` | `10000` | Gateway timeout for payment commands (above generic timeout) |
| `RELAY_POLL_INTERVAL_MS` / `RELAY_MAX_RETRIES` | `500` / `5` | Outbox poll interval and attempts before dead-letter |
| `JOB_POLL_INTERVAL_MS` | `500` | Job worker poll interval |
| `WATCHDOG_INTERVAL_MS` | `60000` | Watchdog evaluation interval (`0` disables) |
| `WATCHDOG_STUCK_EXECUTING_MS` | `300000` | Stuck-payment threshold |
| `WATCHDOG_OUTBOX_LAG_MS` | `60000` | Outbox lag threshold |
| `WATCHDOG_PENDING_JOB_AGE_MS` | `300000` | Oldest pending job threshold |
| `AUDIT_CHAIN_VERIFY_INTERVAL_MS` | `86400000` | Audit-chain verify job interval (`0` disables) |
| `SIMULATED_STATEMENT_EMIT` | unset | `"true"`: simulated rail emits a statement per settlement (demo/test only) |

## Webhooks And Secrets

| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | unset | Global webhook HMAC secret (must not be the sandbox default in production) |
| `DEMO_WEBHOOK_SECRET` | `sandbox-webhook-secret` | Demo/simulated provider fallback secret |
| `CORS_ORIGIN` | same-origin | Explicit allowed origin; cannot be `*` in production |

Webhook signatures are HMAC-SHA256 over the **exact raw request body bytes** (hex, header
`x-webhook-signature`); re-serialized JSON is rejected. Never commit secrets or log them.

## Production Gate

`validateProductionConfig()` (packages/shared/config.mjs) runs at boot and requires:
`PRODUCTION_MODE=true`, `AUTH_REQUIRED=true`, `INTERNAL_AUTH_REQUIRED=true`, a non-default
`INTERNAL_SERVICE_TOKEN` and `SERVICE_DB_PASSWORD`, explicit `CORS_ORIGIN`, non-local
`DATABASE_URL`, `NODE_ENV=production`, plus `SESSION_COOKIE_SECURE=true` and non-default
`WEBHOOK_SECRET`/`DEMO_WEBHOOK_SECRET` for the gateway. Failure crashes boot.

## Local Defaults

`AUTH_REQUIRED` and `INTERNAL_AUTH_REQUIRED` off, `INTERNAL_SERVICE_TOKEN=dev-internal-token`,
demo users have password `demo123`, and demo reset is allowed. These must never carry into
a non-local environment.
