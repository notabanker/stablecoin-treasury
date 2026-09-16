# Release Checklist

## Pre-Deployment

- [ ] `npm run check` passes (syntax, migration lint, prod-config gate)
- [ ] `npm run test:all` passes (unit + integration + concurrency)
- [ ] `npm run invariants` exits 0 against the target database
- [ ] `node scripts/verify-audit-chain.mjs` exits 0 against the target database
- [ ] `npm run smoke` passes against the staging stack
- [ ] `ALLOW_DEMO_RESET` is not set in production

## Configuration

- [ ] `PRODUCTION_MODE=true`, `NODE_ENV=production`
- [ ] `AUTH_REQUIRED=true`, `INTERNAL_AUTH_REQUIRED=true`
- [ ] `INTERNAL_SERVICE_TOKEN` is unique and not the dev default
- [ ] `SERVICE_DB_PASSWORD` is rotated off the dev default
- [ ] `DATABASE_URL` points at the production database (not localhost)
- [ ] `CORS_ORIGIN` is the exact frontend origin
- [ ] `SESSION_COOKIE_SECURE=true`
- [ ] `WEBHOOK_SECRET` / `DEMO_WEBHOOK_SECRET` are set and not the sandbox default
- [ ] `TRUST_PROXY_HEADERS=true` only if a trusted proxy overwrites `X-Forwarded-For`

## Database

- [ ] All migrations applied: `npm run migrate`
- [ ] No demo credentials remain: `SELECT count(*) FROM identity.users WHERE password_hash LIKE 'scrypt$%'` is the expected seed state only; remove any seeded demo users
- [ ] Wallet balances non-negative and ledger transactions balanced (`npm run invariants`)
- [ ] No NULL `tenant_id` in `platform.jobs` / `platform.outbox_events`

## Security Probes

- [ ] Cookie mutation without `X-Csrf-Token` → `403 csrf_invalid`
- [ ] Unsigned direct call to an internal service → `401 internal_auth_required`
- [ ] Cross-tenant reads/writes return 404 (app) and zero rows / `permission denied` (RLS/roles)
- [ ] Webhook with invalid signature → `401 invalid_signature`
- [ ] Reused `Idempotency-Key` with a different body → `422 idempotency_key_reuse`
- [ ] Demo reset under `PRODUCTION_MODE` without the flag → `403 demo_reset_disabled`

## Monitoring After Deploy

- [ ] Gateway `/health` and `/ready` return 200; workers `/health` return 200
- [ ] Relay worker polling and delivering (`/metrics`: `unpublishedCount`, `deadLetterCount`)
- [ ] Job worker claiming and completing; DLQ empty
- [ ] Outbox lag and stuck-`Executing` counts stable

## Rollback

1. Deploy the previous image tag (N-1 code must run against the current schema).
2. Verify `/health`, `/ready`, and `/api/state` consistency.
3. Migrations are forward-only — do not attempt downgrades; restore from backup instead.
