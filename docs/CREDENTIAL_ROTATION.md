# Credential Rotation

This document describes how credentials are managed across the platform and the rotation procedure for each type.

## Credential Inventory

| Credential | Location | Rotation Frequency | Rotation Method |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | Environment variable | Quarterly | Generate new HMAC-SHA256 token, update in secrets manager + env, rolling restart |
| `WEBHOOK_SECRET` | Environment variable | Quarterly | Generate new HMAC-SHA256 secret, update provider config, verify webhook delivery |
| `SESSION_COOKIE_SECURE` | Environment variable | Per-deploy | Set `SESSION_COOKIE_SECURE=true` in production; cookie keys change on deploy |
| `SERVICE_DB_PASSWORD` | Environment variable / secrets manager | Quarterly | Update Postgres role password, update env, verify connectivity |
| User passwords | `identity.users.password_hash` | Per-user action | Users reset via CLI / support; hashed with scrypt (see `packages/shared/auth.mjs`) |
| Session tokens | `identity.sessions.token` | Per-login | Automatically rotated on every login (session fixation prevention) |
| CSRF tokens | `identity.sessions.csrf_token` | Per-login | Automatically generated and set as HttpOnly cookie on login |
| TLS certificates | Infra / WAF | Per-certificate | External — see `docs/RUNBOOKS.md` for renewal procedure |

## Rotation Procedure

### Internal Service Token

1. Generate a new token:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `INTERNAL_SERVICE_TOKEN` in the secrets manager.
3. Deploy the new token to all services (`api-gateway`, `wallet-service`, `payment-service`, etc.).
4. Perform a rolling restart to pick up the new value.
5. Verify: run `npm run test:integration` — the HMAC-signed internal auth tests must pass.

### Webhook Secret

1. Generate a new secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `WEBHOOK_SECRET` in the environment.
3. Update the provider dashboard with the new secret.
4. Verify: run `tests/integration/webhooks.test.mjs` — signature validation must pass.

### Database Passwords

1. Connect as superuser:
   ```bash
   psql "${DATABASE_URL}"
   ```
2. Rotate each service role:
   ```sql
   ALTER ROLE svc_wallet WITH PASSWORD 'new-password';
   ALTER ROLE svc_payment WITH PASSWORD 'new-password';
   -- ... repeat for all service roles
   ```
3. Update `SERVICE_DB_PASSWORD` in the secrets manager.
4. Verify: restart services and confirm `npm run test:integration` passes.

## Production Gate

The `validateProductionConfig()` function in `packages/shared/config.mjs` enforces that:
- `INTERNAL_SERVICE_TOKEN` is set and not the development default
- `SERVICE_DB_PASSWORD` is not the development default (`service-dev-password`)
- `DATABASE_URL` does not point to localhost
- `CORS_ORIGIN` is set and not a wildcard
- `AUTH_REQUIRED=true`, `INTERNAL_AUTH_REQUIRED=true`
- `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`

This gate runs on every service startup and prevents a service from booting with unsafe defaults in production. See `tests/unit/config.test.mjs` for validation test cases.

## Design Decisions

- ADR-008 (pending): secrets manager selection for production credential storage.
- ADR-010: rate limiters are in-memory per process — credentials are not shared across replicas in the current single-instance pilot.
- Session fixation prevention: old session tokens are invalidated on every new login.
- Audit events are emitted for login, logout, and security-sensitive operations, providing an audit trail for credential usage.
