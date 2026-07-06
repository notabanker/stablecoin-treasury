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
| `PAYMENT_MUTATION_TIMEOUT_MS` | `10000` | Gateway timeout for payment create/approve/execute/cancel calls. Kept above the generic timeout so a slow money-path mutation does not return a false 504 after the payment service commits. |
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
| `SESSION_IDLE_TTL_MINUTES` | `0` (disabled) | Idle timeout: session expires after N minutes of inactivity. When set, `validateSession` bumps `expires_at` forward on each request (at most once per minute). |
| `SESSION_ABSOLUTE_TTL_HOURS` | `24` | Absolute max session lifetime from `created_at`; idle-timeout bumps never exceed this cap. |
| `WATCHDOG_INTERVAL_MS` | `60000` | Ops-watchdog evaluation interval. Set to `0` to disable watchdog scheduling. |
| `WATCHDOG_STUCK_EXECUTING_MS` | `300000` | Payment stuck-in-Executing threshold for watchdog alerts. |
| `WATCHDOG_OUTBOX_LAG_MS` | `60000` | Outbox lag threshold for watchdog alerts. |
| `WATCHDOG_PENDING_JOB_AGE_MS` | `300000` | Oldest pending job age threshold for watchdog alerts. |
| `AUDIT_CHAIN_VERIFY_INTERVAL_MS` | `86400000` (nightly) | Interval for the `audit-chain-verify` job that recomputes the tamper-evident audit hash chain and raises an `Audit chain integrity violation` alert on a break. Set to `0` to disable scheduling. Standalone check: `node scripts/verify-audit-chain.mjs`. |
| `SERVICE_DB_PASSWORD` | `service-dev-password` | Password for the per-service Postgres roles (`svc_*`, migration 0033). **Must be overridden in any non-local deployment** — the default is a dev-only literal. |
| `SIMULATED_STATEMENT_EMIT` | unset | When `"true"`, the simulated rail emits a one-line provider statement on every settlement (job worker → reconciliation `/statements`), driving the full settle → ingest → match path without a partner. Default off: enabling changes reconciliation counts (a statement-confirmed match per settlement). Test/demo aid only. |

## Database Roles and Row-Level Security

- Every service connects as its own Postgres role (`svc_wallet`, `svc_payment`, …,
  migration 0033) with grants limited to its own schema plus explicitly inventoried
  cross-schema needs. A leaked service credential no longer exposes other domains.
- Row-level security (migrations 0037–0044) tenant-scopes every tenant-carrying table.
  Policies check the transaction-local `app.tenant_id` set by `packages/shared/db.mjs`;
  the context enters per request from the `X-Tenant-Id` header (`createJsonService`) and
  explicitly in non-request paths (seeds, bootstraps, audit inserts, webhook processing).
  A missing context **fails closed** (zero rows), so an application query that forgets its
  tenant WHERE clause cannot leak another tenant's rows.
- Documented exceptions:
  - `identity.*` has **no RLS**: it is the tenant-resolution root (login by email and
    session lookup by token happen before any tenant is known). Only `svc_gateway` holds
    grants there.
  - `operations.providers` has a SELECT-only `USING (true)` policy for `svc_gateway`:
    webhook ingestion derives the tenant FROM the provider registry, the same circularity
    as identity. The gateway's grant is read-only.
  - `platform.inbox_events` carries no tenant column (PK event_id + consumer) — no RLS.
  - `wallet.ledger_entries` carries no tenant column; it is reachable only through
    RLS-scoped parents. `wallet.wallet_balances` is a **view** with
    `security_invoker = true` so the caller's RLS applies to the tables underneath.
  - `svc_relay` and `svc_job` carry `BYPASSRLS`: the relay and job worker legitimately
    operate across all tenants (outbox delivery, job claiming, watchdog, audit-chain
    verification). Domain services never bypass RLS.

## Client IP and Rate Limiting

- By default the client IP is the socket peer address; `X-Forwarded-For` is ignored so it cannot
  be spoofed by direct callers.
- Set `TRUST_PROXY_HEADERS=true` **only** when every request reaches the service through a trusted
  reverse proxy that overwrites `X-Forwarded-For`. The leftmost entry is then used as the canonical
  client IP.
- The same canonical client IP feeds request context (`ctx.clientIp`), the gateway general/state API
  limiters, and the login rate limiter, so per-client buckets stay consistent behind a proxy.
- `GET /health` bypasses API rate limiting so orchestrator health checks never consume tokens.
- Internal services that set `internalAuthRequired: true` disable the shared HTTP rate limiter by
  default. Their traffic is already gateway/worker-originated; counting fanout against the same
  per-IP bucket can self-throttle legitimate payment bursts. External ingress throttling belongs at
  the gateway and, later, at the cloud/WAF layer.
- **Rate limiters are per-process, in-memory only.** The token buckets and login lockout
  counters live in each gateway instance's `Map` and are not shared across replicas. A
  gateway restart clears all rate-limit state. This is acceptable while the gateway runs
  as a single instance (the current pilot deployment model). If horizontal scaling is
  introduced, rate limiting must move to a shared backend or ingress control (Redis, WAF, or equivalent) —
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
- `identity.sessions.csrf_token` is `NOT NULL` at schema level (migration 0030); legacy null rows
  are deleted on migration. Runtime strictness (`verifyCsrf`) is kept as defense in depth — it
  also covers empty-string tokens and ensures the same behavior even if a migration is reverted.
- When `SESSION_COOKIE_SECURE=true`, cookies use the `__Host-` prefix (`__Host-session`,
  `__Host-csrf`) which requires `Secure`, `Path=/`, and no `Domain` attribute. The frontend
  and server cookie-parsing code accept both prefixed and plain cookie names, so a mix of
  secure and non-secure deployments works seamlessly.

## Session Lifecycle

- **Rotation:** Successful login destroys any session presented in the request cookie before
  issuing a new one (prevents session fixation).
- **Idle timeout:** When `SESSION_IDLE_TTL_MINUTES > 0`, `validateSession` extends `expires_at`
  forward by that many minutes from each request, capped at `SESSION_ABSOLUTE_TTL_HOURS` from
  session creation. Bumps occur at most once per minute to avoid write amplification.
- **Logout:** The response includes `Max-Age=0` cookies for both session and csrf, clearing
  them client-side. The DB row is also destroyed.

## Security Headers

- `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` is set on all responses.
- `X-Frame-Options: DENY` is set on all responses.
- **HSTS (`Strict-Transport-Security`) is NOT set by the application.** It is the
  responsibility of the TLS-terminating ingress/reverse proxy. Document here for clarity.

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
