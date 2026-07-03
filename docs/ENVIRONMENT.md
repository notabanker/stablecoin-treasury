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
| `ALLOW_DEMO_RESET` | unset | Allow reset in production |

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
