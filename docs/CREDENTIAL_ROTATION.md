# Credential Rotation

## Inventory

| Credential | Location | Frequency | Method |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | env / secrets manager | Quarterly | New random token, update all services, rolling restart |
| `WEBHOOK_SECRET` | env / per-provider `operations.providers.webhook_secret` | Quarterly | New secret on both sides, verify delivery |
| `SERVICE_DB_PASSWORD` | env / secrets manager | Quarterly | `ALTER ROLE svc_* WITH PASSWORD ...`, update env, restart |
| User passwords | `identity.users.password_hash` | Per-user action | Reset by support; scrypt hashes (`packages/shared/auth.mjs`) |
| Session tokens | `identity.sessions.token` | Per login | Rotated automatically on every login |
| CSRF tokens | `identity.sessions.csrf_token` | Per login | Generated on login, set as cookie |
| TLS certificates | Ingress / reverse proxy | Per certificate | External to the app (do not set HSTS in app; ingress does) |

## Procedures

### Internal Service Token

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Update `INTERNAL_SERVICE_TOKEN` in the secrets manager / environment.
3. Deploy to every service; rolling restart.
4. Verify: `npm run test:integration` (internal-auth tests must pass).

### Webhook Secret

1. Generate a new secret (same command as above).
2. Update `WEBHOOK_SECRET` (and the provider config) plus `operations.providers.webhook_secret`.
3. Verify: `tests/integration/webhooks.test.mjs`; send a signed test delivery.
4. Signatures are HMAC-SHA256 over the exact raw body (hex, `x-webhook-signature`).

### Database Passwords

1. Connect as superuser: `psql "${DATABASE_ADMIN_URL}"`.
2. Rotate each role: `ALTER ROLE svc_wallet WITH PASSWORD 'new-password';` (repeat per role).
3. Update `SERVICE_DB_PASSWORD` in the secrets manager.
4. Restart services and verify `npm run test:integration`.

## Production Gate

`validateProductionConfig()` (packages/shared/config.mjs) blocks boot in `PRODUCTION_MODE`
when: `AUTH_REQUIRED` or `INTERNAL_AUTH_REQUIRED` are not `true`; `INTERNAL_SERVICE_TOKEN`
or `SERVICE_DB_PASSWORD` are unset/default; `DATABASE_URL` points at localhost/`treasury_dev`;
`CORS_ORIGIN` is unset or `*`; `NODE_ENV` is not production; and, for the gateway,
`SESSION_COOKIE_SECURE` is not true or the webhook secrets are defaults.

## Notes

- Secrets never belong in source, committed env files, logs, tests, or docs. Errors are
  redacted (first/last 4 chars only).
- ADR-010: rate limiters and login lockout are per-process in-memory — not shared across replicas.
- Sessions are rotated on login (fixation prevention); failed logins and lockouts are
  audited under the resolved user's tenant.
