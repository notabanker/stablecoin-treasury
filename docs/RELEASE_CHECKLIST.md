# V5 Release Checklist

## Pre-Deployment

- [ ] `npm run check` passes (syntax + migration lint + prod config check)
- [ ] `npm run test` passes (unit tests)
- [ ] `npm run test:integration` passes
- [ ] `npm run test:concurrency` passes
- [ ] `npm run smoke` passes against staging environment

## Config Validation

- [ ] `PRODUCTION_MODE=true npm run check:prod-config` passes
- [ ] `AUTH_REQUIRED=true`
- [ ] `INTERNAL_AUTH_REQUIRED=true`
- [ ] `INTERNAL_SERVICE_TOKEN` is set and unique
- [ ] `DATABASE_URL` points to production database
- [ ] `CORS_ORIGIN` is set to frontend domain
- [ ] `SESSION_COOKIE_SECURE=true`
- [ ] `NODE_ENV=production`
- [ ] `DEMO_WEBHOOK_SECRET` is not the default
- [ ] `WEBHOOK_SECRET` is configured

## Database

- [ ] All migrations applied: `npm run migrate`
- [ ] `SELECT count(*) FROM identity.users WHERE password_hash = 'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791'` returns 0 (no demo passwords)
- [ ] Wallet balances are non-negative: `SELECT count(*) FROM wallet.wallet_balances WHERE balance < 0` returns 0
- [ ] All ledger transactions balanced
- [ ] No null `tenant_id` in platform tables

## Security

- [ ] Demo reset disabled: `ALLOW_DEMO_RESET` is not set
- [ ] Login rate limiting configured
- [ ] Internal service auth enabled
- [ ] Session cookies include `Secure` flag
- [ ] `HttpOnly` on session cookies verified via browser dev tools
- [ ] Webhook signatures validated for all providers
- [ ] `TRUST_PROXY_HEADERS=true` only if a trusted proxy overwrites `X-Forwarded-For`

## Adversarial Probes (run against staging)

- [ ] Cookie-authenticated `POST /api/logout` without `X-Csrf-Token` returns `403 csrf_invalid`
- [ ] Cookie-authenticated `POST /api/logout` with correct `X-Csrf-Token` returns `200`
- [ ] Cookie-authenticated mutation with session `csrf_token=NULL` returns `403 csrf_invalid`
- [ ] Failed login for a known non-default-tenant email writes `Login failed` under that tenant
- [ ] Lockout for a known non-default-tenant email writes `Login lockout` under that tenant
- [ ] Unknown-email failed login writes audit under the default platform tenant
- [ ] With `TRUST_PROXY_HEADERS=true`, distinct `X-Forwarded-For` IPs get distinct rate-limit buckets
- [ ] With `TRUST_PROXY_HEADERS` unset, spoofed `X-Forwarded-For` does not bypass the socket-IP limiter
- [ ] Unsigned direct request to an internal service returns `401 internal_auth_required`
- [ ] `node scripts/verify-audit-chain.mjs` exits 0 against the target database
- [ ] Corrupting an audit row in a scratch copy is detected by the verifier (named row + reason) and raises the `Audit chain integrity violation` alert within one verify interval
- [ ] WHERE-less `SELECT` under a domain service role returns only the context tenant's rows; no context returns zero rows (fail closed)
- [ ] Cross-tenant `INSERT` under a domain service role is rejected by the RLS `WITH CHECK`
- [ ] Cross-schema `SELECT` under a domain service role (e.g. wallet role reading `payment.payments`) returns `permission denied`
- [ ] Idempotency-key collision across tenants produces two distinct keys (tenant-scoped uniqueness) — no cross-tenant leakage
- [ ] Webhook processing under tenant-1 context cannot see or affect tenant-2 payments
- [ ] Audit reads are strictly tenant-scoped: each tenant sees only its own rows
- [ ] Repair/attempts listing is tenant-scoped: tenant-2 cannot see tenant-1's failed payments or execution attempts
- [ ] `SERVICE_DB_PASSWORD` is not the dev default in any non-local environment

## Rollback Plan

1. Deploy previous Docker image tag
2. Run any down-migration if needed (manual, review first)
3. Verify health endpoints
4. Verify state endpoint returns consistent data

## Monitoring

- [ ] All service /metrics endpoints return JSON
- [ ] Gateway /health returns 200
- [ ] Worker /health returns 200
- [ ] Relay worker is polling and delivering
- [ ] Job worker is claiming and executing
- [ ] Outbox queue depth is not growing unboundedly
