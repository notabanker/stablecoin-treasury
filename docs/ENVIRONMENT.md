# Environment Configuration

## Required (Production Mode)

| Variable | Purpose | Must NOT be default |
|---|---|---|
| `PRODUCTION_MODE` | Enable production hardening | `"true"` |
| `AUTH_REQUIRED` | Enforce authentication | `"true"` |
| `INTERNAL_AUTH_REQUIRED` | Enforce internal service auth | `"true"` |
| `INTERNAL_SERVICE_TOKEN` | Shared internal HMAC secret | Unique per deployment |
| `DATABASE_URL` | PostgreSQL connection | Not localhost or treasury_dev |
| `CORS_ORIGIN` | Allowed CORS origin | Explicit domain, not `*` |
| `NODE_ENV` | Node environment | `"production"` |
| `SESSION_COOKIE_SECURE` | Require Secure cookie flag | `"true"` |
| `WEBHOOK_SECRET` | Global webhook fallback secret | Not `sandbox-webhook-secret` |
| `DEMO_WEBHOOK_SECRET` | Demo webhook fallback secret | Not `sandbox-webhook-secret` |

## Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | varies | Service port |
| `HOST` | `127.0.0.1` | Bind address |
| `SERVICE_TIMEOUT_MS` | `2500` | Service call timeout |
| `SERVICE_RETRIES` | `2` | Service call retries |
| `RELAY_POLL_INTERVAL_MS` | `500` | Outbox poll interval |
| `JOB_POLL_INTERVAL_MS` | `500` | Job poll interval |
| `RATE_LIMIT_WINDOW_MS` | `1000` | Rate limit window |
| `RATE_LIMIT_MAX` | `200` | General rate limit |
| `STATE_RATE_LIMIT_MAX` | `50` | State endpoint rate limit |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | `60000` | Login failure window |
| `LOGIN_RATE_LIMIT_MAX` | `5` | Max login failures |
| `LOGIN_LOCKOUT_MS` | `300000` | Lockout duration |
| `TRUST_PROXY_HEADERS` | unset | Honor `X-Forwarded-For` for client IP (see below) |
| `ALLOW_DEMO_RESET` | unset | Allow reset in production |

## Client IP and Rate Limiting

- By default the client IP is the socket peer address; `X-Forwarded-For` is ignored so it cannot
  be spoofed by direct callers.
- Set `TRUST_PROXY_HEADERS=true` **only** when every request reaches the service through a trusted
  reverse proxy that overwrites `X-Forwarded-For`. The leftmost entry is then used as the canonical
  client IP.
- The same canonical client IP feeds request context (`ctx.clientIp`), the general/state API rate
  limiters, and the login rate limiter, so per-client buckets stay consistent behind a proxy.
- `GET /health` bypasses API rate limiting so orchestrator health checks never consume tokens.
- **Rate limiters are per-process, in-memory only.** The token buckets and login lockout
  counters live in each service instance's `Map` and are not shared across replicas. A
  service restart clears all rate-limit state. This is acceptable while each service runs
  as a single instance (the current pilot deployment model). If horizontal scaling is
  introduced, rate limiting must move to a shared backend (Redis or equivalent) —
  see `docs/adr/ADR-010-single-process-rate-limiting.md` for the decision and its
  revisit triggers.

## Login Audit Tenant Attribution

- Failed-login and lockout security audit events for a **known** email are written under that
  user's tenant (resolved by normalized email before password verification; existence is never
  leaked through the API response).
- Failed logins for **unknown** emails are written under the default platform tenant
  (`00000000-0000-0000-0000-000000000001`). This fallback is intentional: there is no tenant to
  attribute to, and platform operators still need visibility into credential-stuffing attempts.

## CSRF Sessions

- Cookie-authenticated mutating requests require a matching `X-Csrf-Token` header. Sessions with a
  missing/`NULL` `csrf_token` are rejected with `403 csrf_invalid` — they cannot mutate.
- `identity.sessions.csrf_token` remains nullable in the schema; strictness is enforced at runtime
  (`verifyCsrf`) and covered by regression tests. A `NOT NULL` constraint is deliberately deferred:
  schema changes require explicit human approval, and backfilling a token for legacy rows would not
  make them usable anyway (the browser never received that token).

## Secret Handling

- Never commit `.env` files
- Never hardcode secrets in source
- Use environment variables or a secrets manager
- `INTERNAL_SERVICE_TOKEN` must be cryptographically random (64+ hex chars recommended)
- `WEBHOOK_SECRET` should match the secret configured in `operations.providers.webhook_secret`

## Local Development Defaults

Safe for `127.0.0.1` development:
- `AUTH_REQUIRED` defaults to off
- `INTERNAL_AUTH_REQUIRED` defaults to off
- `INTERNAL_SERVICE_TOKEN` defaults to `dev-internal-token`
- Demo password: `demo123`
