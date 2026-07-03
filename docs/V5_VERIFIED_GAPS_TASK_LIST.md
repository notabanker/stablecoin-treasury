# V5 Verified Gaps Task List

This backlog is based on the current V5 verification pass. The normal suite is green, but the items below were reproduced against the running code and must be fixed before claiming production readiness.

Current verified status:

- `npm run check` passes.
- Unit tests pass: 46/46.
- Integration tests pass: 33/33.
- Concurrency tests pass: 4/4.
- Smoke test passes.
- DB invariants pass: no negative balances, no unbalanced ledgers, no null tenant IDs in jobs or outbox.

Remaining production blockers:

- Internal service auth is implemented but not enforced by service routes.
- CSRF support is implemented but not enforced on cookie-authenticated mutations.
- Rate limiting uses an IP-only bucket, so `/api/state` can inherit the wider general route limit.
- Login brute-force limiting hardcodes the client IP to `127.0.0.1`.
- Security audit events always write to the default tenant.

## Definition of Done

V5 hardening is complete only when all of the following are true:

- Every reproduced failure below has a failing regression test before the fix or an explicit adversarial test proving the old behavior.
- Every fixed behavior has automated coverage in unit, integration, or concurrency tests.
- `npm run check` passes.
- `npm run test` passes.
- `npm run test:integration` passes.
- `npm run test:concurrency` passes.
- `npm run smoke` passes against a live local stack.
- The DB invariant query returns zero for negative balances, unbalanced ledgers, jobs without tenant, and outbox events without tenant.
- Documentation no longer claims stronger security behavior than the code actually enforces.

## Epic 1 - Enforce Internal Service Authentication

Severity: HIGH  
Risk: Direct calls to domain services can bypass the gateway and spoof `X-Tenant-Id` when the service port is reachable. The current code signs outgoing service-client requests, but the receiving services do not validate signatures.

Observed failure:

- With `INTERNAL_AUTH_REQUIRED=true` and `INTERNAL_SERVICE_TOKEN` set, an unsigned direct request to the wallet service still succeeds:
  - `GET /wallets`
  - Header: `X-Tenant-Id: 00000000-0000-0000-0000-000000000002`
  - Actual result: `200`
  - Required result: `401`

Primary files:

- `packages/shared/http.mjs`
- `packages/shared/service-client.mjs`
- `services/wallet-service/src/index.mjs`
- `services/policy-service/src/index.mjs`
- `services/compliance-service/src/index.mjs`
- `services/payment-service/src/index.mjs`
- `services/accounting-service/src/index.mjs`
- `services/reconciliation-service/src/index.mjs`
- `services/operations-service/src/index.mjs`
- `services/api-gateway/src/index.mjs`
- `services/relay-worker/src/index.mjs`
- `services/job-worker/src/index.mjs`
- `tests/helpers/stack.mjs`

### Task 1.1 - Decide and implement the enforcement boundary

Subtasks:

- Treat the API gateway as the public edge.
- Treat wallet, policy, compliance, payment, accounting, reconciliation, and operations services as internal-only.
- Require internal auth on all internal-service business routes when `INTERNAL_AUTH_REQUIRED=true`.
- Keep only explicitly public operational routes unauthenticated:
  - `GET /health`
  - `GET /metrics`
  - any local-only readiness route that is intentionally public
- Do not require internal auth on browser-facing API gateway routes.
- Confirm whether relay-worker and job-worker expose any non-metrics HTTP routes. If they do, classify them as public or internal and enforce accordingly.

Implementation options:

- Preferred: extend `createJsonService` with a service-level option such as `internalAuthRequired: true` and per-route metadata such as `public: true`.
- Acceptable: wrap every private service route handler with `validateInternalAuth`.
- Avoid relying on developers to remember wrappers for future routes without a test that catches unprotected additions.

Acceptance criteria:

- When `INTERNAL_AUTH_REQUIRED=false`, local dev behavior remains unchanged.
- When `INTERNAL_AUTH_REQUIRED=true`, unsigned requests to internal business routes return `401`.
- Signed requests from `service-client.mjs` continue to work.
- `GET /health` and `GET /metrics` remain reachable without a signature.

### Task 1.2 - Harden signature validation

Subtasks:

- Use `crypto.timingSafeEqual` for signature comparison.
- Reject missing signatures.
- Reject malformed signatures without throwing.
- Include enough request material in the signature to prevent body/path confusion:
  - HTTP method
  - pathname
  - canonical JSON body or raw body hash
- Add a timestamp header if replay resistance is in scope for this milestone.
- If timestamp is added, reject signatures outside a small clock-skew window.

Acceptance criteria:

- Wrong signature returns `401`.
- Signature for the wrong body returns `401`.
- Signature for the wrong path returns `401`.
- Signature for the wrong method returns `401`.
- Valid signature returns the normal service response.

### Task 1.3 - Add regression tests

Subtasks:

- Add an integration test that starts the stack with:
  - `INTERNAL_AUTH_REQUIRED=true`
  - `INTERNAL_SERVICE_TOKEN=<test-token>`
- Test unsigned direct requests against at least wallet and payment service business routes.
- Test signed `service-client` requests still work through the gateway.
- Test `GET /health` is still public.
- Test invalid signature, missing signature, and mismatched-body signature.
- Add a route-coverage test that fails if internal services expose unclassified routes when internal auth is required.

Required adversarial repro after fix:

```bash
INTERNAL_AUTH_REQUIRED=true INTERNAL_SERVICE_TOKEN=test-internal-token npm run test:integration
```

Expected direct-call behavior:

```text
GET http://127.0.0.1:<wallet-port>/wallets
X-Tenant-Id: <tenant-2-id>

Expected: 401 internal_auth_required
```

## Epic 2 - Enforce CSRF on Cookie-Authenticated Mutations

Severity: HIGH  
Risk: The app sets session cookies and CSRF cookies, but gateway mutation routes do not use the CSRF-protected auth wrapper. A browser can currently submit cookie-authenticated mutations without `X-Csrf-Token`.

Observed failure:

- With `AUTH_REQUIRED=true`, login returns cookies.
- `POST /api/payments` using only cookies and no `X-Csrf-Token` succeeds.
- Required result: `403 csrf_invalid`.

Primary files:

- `packages/shared/auth.mjs`
- `services/api-gateway/src/index.mjs`
- `apps/web/main.js`
- `tests/integration/auth-rbac.test.mjs`
- `tests/helpers/stack.mjs`

### Task 2.1 - Track authentication source

Subtasks:

- Update token extraction so the auth layer knows whether the session token came from:
  - `Cookie: session=...`
  - `Authorization: Bearer ...`
  - local dev fallback
- Add `context.user.authSource` or equivalent.
- Ensure cookie-authenticated mutating requests require CSRF.
- Ensure bearer-authenticated requests follow the intended policy:
  - either skip CSRF because bearer auth is not ambient browser auth
  - or require CSRF consistently if bearer tokens are still used by browser code
- Document the chosen policy.

Acceptance criteria:

- CSRF checks only apply to the intended auth source.
- The behavior matches comments in `auth.mjs`.
- Tests cover cookie and bearer behavior explicitly.

### Task 2.2 - Wire CSRF into gateway route guards

Subtasks:

- Replace mutation route wrappers in `services/api-gateway/src/index.mjs` so they use CSRF enforcement.
- Keep read-only routes such as `GET /api/state`, `GET /api/repair`, and `GET /api/payments/:id/attempts` free from CSRF requirements.
- Apply CSRF enforcement to all browser-originating mutating routes:
  - `POST /api/logout`
  - `POST /api/reset`
  - `POST /api/payments`
  - `POST /api/payments/:id/approve`
  - `POST /api/payments/:id/execute`
  - `POST /api/payments/:id/cancel`
  - `POST /api/policies`
  - `POST /api/policies/assets/:assetId`
  - `POST /api/reconciliation/:id/resolve`
  - `POST /api/reconciliation/exceptions/simulate`
  - `POST /api/operations/providers/:id/toggle`
  - `POST /api/operations/incidents/simulate`
  - `POST /api/accounting/export`
  - `POST /api/repair/:id/retry`
- Do not apply session CSRF to provider webhooks unless they are also browser-cookie authenticated. Webhooks use signature authentication.

Acceptance criteria:

- Cookie-only mutation without `X-Csrf-Token` returns `403 csrf_invalid`.
- Cookie plus correct `X-Csrf-Token` succeeds.
- Cookie plus wrong `X-Csrf-Token` returns `403 csrf_invalid`.
- Webhook signature flow remains unchanged.

### Task 2.3 - Tighten session and CSRF token behavior

Subtasks:

- Change `verifyCsrf` so missing session CSRF does not silently pass for cookie-authenticated mutations in auth-required mode.
- Decide whether login should keep returning `session.token` and `csrfToken` in the JSON body.
- Preferred hardening:
  - keep `csrfToken` available through the readable `csrf` cookie
  - stop returning the session token in the JSON body for browser login
  - avoid storing session tokens in frontend memory or `localStorage`
- Confirm `apps/web/main.js` reads the CSRF cookie and sends `X-Csrf-Token` on every mutation.
- Confirm logout clears both `session` and `csrf` cookies.

Acceptance criteria:

- Frontend continues to work without `localStorage`.
- Session cookie is `HttpOnly`.
- CSRF cookie is readable by frontend JS.
- `SESSION_COOKIE_SECURE=true` adds `Secure` to both cookies.

### Task 2.4 - Add regression tests

Subtasks:

- Add integration test: login, then create payment without CSRF header. Expect `403`.
- Add integration test: login, then create payment with CSRF header. Expect `200`.
- Add integration test: wrong CSRF header. Expect `403`.
- Add integration test: `GET /api/state` with cookie and no CSRF. Expect `200`.
- Add UI-level smoke coverage or scripted browser check that a normal payment mutation sends `X-Csrf-Token`.

Required adversarial repro after fix:

```text
POST /api/payments
Cookie: session=<valid>; csrf=<valid>
Missing X-Csrf-Token

Expected: 403 csrf_invalid
```

## Epic 3 - Fix Rate-Limit Bucket Isolation

Severity: MEDIUM-HIGH  
Risk: `/api/state` has a tighter configured limit, but the bucket key is only the IP. A general route can create a bucket with the wider limit, allowing more state reads than intended.

Observed failure:

- Environment:
  - `RATE_LIMIT_WINDOW_MS=10000`
  - `RATE_LIMIT_MAX=10`
  - `STATE_RATE_LIMIT_MAX=2`
- Request sequence:
  - `GET /api/docs`
  - `GET /api/state`
  - `GET /api/state`
  - `GET /api/state`
  - `GET /api/state`
- Actual statuses:
  - `200, 200, 200, 200, 429`
- Required behavior:
  - third state read in the same window should return `429`.

Primary files:

- `packages/shared/http.mjs`
- `tests/unit` or `tests/integration`
- `tests/helpers/stack.mjs`

### Task 3.1 - Split limiter buckets by route class

Subtasks:

- Change the bucket key from IP-only to IP plus limiter policy.
- Suggested key shape:
  - `state:<client-ip>`
  - `general:<client-ip>`
- Keep `/api/state` on `STATE_RATE_LIMIT_MAX`.
- Keep all other routes on `RATE_LIMIT_MAX`.
- Confirm static asset requests are classified intentionally:
  - either general-limited
  - or excluded if they create noisy false positives in local UI
- Preserve `Retry-After` and machine-readable `rate_limited` response.

Acceptance criteria:

- General route traffic does not consume state route quota.
- State route traffic does not consume general route quota.
- `Retry-After` is still set on `429`.

### Task 3.2 - Prepare for proxy-aware client IP

Subtasks:

- Reuse the client IP extraction utility from Epic 4 if implemented first.
- Ensure limiter keys use the same canonical client IP as login rate limiting.
- Do not trust `X-Forwarded-For` unless proxy trust is explicitly enabled.

Acceptance criteria:

- Local direct requests use socket remote address.
- Trusted proxy deployments can use forwarded client IP.
- Untrusted clients cannot spoof limiter buckets with `X-Forwarded-For`.

### Task 3.3 - Add regression tests

Subtasks:

- Add an automated test for the exact sequence above.
- Add reverse sequence test:
  - exhaust `/api/state`
  - verify `/api/docs` or another general route still follows the general route limit
- Test that limiter windows reset.
- Test that `Retry-After` is present and numeric.

Required adversarial repro after fix:

```text
RATE_LIMIT_WINDOW_MS=10000 RATE_LIMIT_MAX=10 STATE_RATE_LIMIT_MAX=2

GET /api/docs  -> 200
GET /api/state -> 200
GET /api/state -> 200
GET /api/state -> 429
```

## Epic 4 - Use Real Client IP for Login Brute-Force Protection

Severity: MEDIUM-HIGH  
Risk: Login rate limiting is currently keyed by a hardcoded `127.0.0.1`. In production behind a proxy, all users share a single lockout bucket. Without trusted proxy handling, attackers can also spoof forwarded headers if the app blindly trusts them.

Observed issue:

- `services/api-gateway/src/index.mjs` sets `const ip = "127.0.0.1"`.

Primary files:

- `packages/shared/http.mjs`
- `packages/shared/auth.mjs`
- `services/api-gateway/src/index.mjs`
- `docs/ENVIRONMENT.md`
- `.env.example`
- `tests/integration/auth-rbac.test.mjs`

### Task 4.1 - Add canonical client IP extraction

Subtasks:

- Add a shared helper for deriving client IP.
- Inputs should include:
  - socket remote address
  - request headers
  - deployment trust configuration
- Default behavior:
  - use socket remote address
  - ignore `X-Forwarded-For`
- Add explicit proxy trust config, for example:
  - `TRUST_PROXY_HEADERS=true`
  - optionally `TRUSTED_PROXY_HOPS=1`
- When trusted, parse `X-Forwarded-For` safely and use the correct client entry.
- Normalize IPv4-mapped IPv6 values such as `::ffff:127.0.0.1`.
- Expose `context.clientIp` from `createJsonService`.

Acceptance criteria:

- Gateway login code uses `context.clientIp`.
- Rate limiter can also use the same helper.
- Spoofed `X-Forwarded-For` is ignored unless trust is enabled.

### Task 4.2 - Apply client IP to login limiter and audit

Subtasks:

- Change `login(body, headers)` to receive the full request context or `clientIp`.
- Use canonical client IP in:
  - `checkLoginRateLimit`
  - `recordLoginFailure`
  - `clearLoginFailures`
  - security audit detail
- Keep the existing key shape of IP plus email.
- Confirm lockout is per email and per client IP.

Acceptance criteria:

- Failures for `alice@example.com` from IP A do not lock out IP B.
- Failures for IP A and email A do not lock out email B unless explicitly intended.
- Successful login clears only the matching IP/email failure bucket.

### Task 4.3 - Add regression tests

Subtasks:

- Test lockout with same IP and same email.
- Test no lockout with different IP and same email when proxy trust is enabled.
- Test no lockout with same IP and different email unless the product intentionally wants IP-wide protection.
- Test `X-Forwarded-For` ignored by default.
- Test `X-Forwarded-For` honored only with trust enabled.
- Update `.env.example` and `docs/ENVIRONMENT.md` for proxy trust settings.

Required adversarial repro after fix:

```text
TRUST_PROXY_HEADERS=true

5 failed logins for email A from 203.0.113.10 -> lockout
login for email A from 203.0.113.11 -> not locked out by 203.0.113.10 bucket
```

## Epic 5 - Tenant-Scope Security Audit Events

Severity: MEDIUM  
Risk: Auth-related audit events currently write to the default tenant. In a multi-tenant platform, tenant 2 login/logout/failure events appear under tenant 1, corrupting the audit trail.

Observed issue:

- `emitSecurityAudit` inserts `DEFAULT_TENANT_ID` for every event.

Primary files:

- `packages/shared/auth.mjs`
- `services/api-gateway/src/index.mjs`
- `services/operations-service/src/index.mjs`
- `db/migrations`
- `tests/integration/auth-rbac.test.mjs`

### Task 5.1 - Redesign `emitSecurityAudit` API

Subtasks:

- Replace positional arguments with an object argument.
- Include `tenantId` explicitly:
  - `emitSecurityAudit({ tenantId, actor, action, object, detail })`
- Update all call sites.
- For successful login, use `user.tenantId`.
- For logout, use `ctx.user.tenantId`.
- For known-user failed login, resolve the tenant before writing the event.
- For unknown-user failed login, choose an explicit strategy:
  - write to a platform/security tenant if one exists
  - write to default tenant with `object=unknown`
  - or add a separate platform-wide security event table
- Document the chosen strategy.

Acceptance criteria:

- Tenant 2 login success creates an audit event under tenant 2.
- Tenant 2 logout creates an audit event under tenant 2.
- Known tenant 2 failed login creates an audit event under tenant 2.
- Unknown email behavior is deterministic and documented.

### Task 5.2 - Avoid leaking sensitive auth material

Subtasks:

- Ensure audit detail never includes passwords, session tokens, CSRF tokens, raw cookies, or provider secrets.
- Consider hashing or truncating unknown email addresses in failed-login audit rows if privacy policy requires it.
- Keep enough metadata for operators:
  - timestamp
  - action
  - actor or normalized identifier
  - client IP
  - failure reason category

Acceptance criteria:

- Tests assert no token/cookie/password-like values appear in auth audit details.
- Audit rows remain useful for investigating lockouts and suspicious login attempts.

### Task 5.3 - Add regression tests

Subtasks:

- Login as a tenant 2 user.
- Query `operations.audit_events`.
- Assert the login event tenant ID equals tenant 2.
- Logout as a tenant 2 user.
- Assert the logout event tenant ID equals tenant 2.
- Failed login for a tenant 2 email.
- Assert the failed-login event is not written under tenant 1.

Required adversarial repro after fix:

```text
Login as tenant 2 user
SELECT tenant_id, action FROM operations.audit_events WHERE action = 'Login success';

Expected: tenant_id = tenant 2
```

## Epic 6 - Update Documentation and Readiness Claims

Severity: MEDIUM  
Risk: Investor and production-readiness documents currently imply some V5 controls are complete even though enforcement gaps remain.

Primary files:

- `docs/V5_COMPLETION_REPORT.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/RUNBOOKS.md`
- `docs/ENVIRONMENT.md`
- `.env.example`
- `README.md`

### Task 6.1 - Correct current V5 security claims

Subtasks:

- Mark internal auth as "implemented and enforced" only after Epic 1 passes.
- Mark CSRF as "implemented and enforced" only after Epic 2 passes.
- Document that local `npm run check` skips production config unless `PRODUCTION_MODE=true`.
- Add the exact command for production config validation with production-shaped env.
- Update readiness verdict:
  - Demo-ready: yes
  - Investor diligence: conditional until these gaps are fixed
  - Production money movement: no until these gaps are fixed and infrastructure controls exist

Acceptance criteria:

- Docs match actual behavior.
- No doc claims a security control is enforced without a test proving it.

### Task 6.2 - Extend release checklist

Subtasks:

- Add internal auth adversarial test.
- Add CSRF adversarial test.
- Add rate-limit route isolation test.
- Add proxy/client IP login limiter test.
- Add tenant-scoped auth audit test.
- Add DB invariant query.
- Add smoke test note that it calls `/api/reset` and must only target disposable environments unless explicitly overridden.

Acceptance criteria:

- A new engineer can run the checklist and reproduce the same proof points.
- Destructive checks are clearly labeled.

## Epic 7 - Final Verification Pass

Severity: REQUIRED  
Risk: The prior suite passed while missing the exact security regressions above. Final verification must include both normal tests and adversarial repros.

### Task 7.1 - Run standard automated checks

Commands:

```bash
npm run check
npm run test
npm run test:integration
npm run test:concurrency
```

Expected:

- All commands exit `0`.
- No skipped security tests unless explicitly justified.

### Task 7.2 - Run production config gate

Command shape:

```bash
PRODUCTION_MODE=true \
AUTH_REQUIRED=true \
INTERNAL_AUTH_REQUIRED=true \
INTERNAL_SERVICE_TOKEN=<non-default-token> \
CORS_ORIGIN=https://treasury.example.com \
DATABASE_URL=postgres://db.internal:5432/treasury_prod \
NODE_ENV=production \
SESSION_COOKIE_SECURE=true \
WEBHOOK_SECRET=<non-default-secret> \
npm run check
```

Expected:

- Production config check runs.
- Production config check passes with safe dummy values.
- Production config check fails when required variables are missing or unsafe.

### Task 7.3 - Start local stack and run smoke

Commands:

```bash
npm run migrate
npm run dev
curl -sf http://127.0.0.1:8080/health
curl -sf http://127.0.0.1:8080/ready
npm run smoke
```

Expected:

- Gateway health returns `{"status":"ok","service":"api-gateway"}`.
- Readiness returns all domain services as `ok`.
- Smoke test exits `0`.

Important:

- `npm run smoke` calls `POST /api/reset`.
- Run it only against local disposable demo state unless `SMOKE_ALLOW_REMOTE=1` is intentionally set for a disposable remote target.

### Task 7.4 - Run DB invariant query

Command:

```bash
psql "${DATABASE_URL:-postgres://127.0.0.1:5432/treasury_dev}" -X -A -F $'\t' -c "
SELECT 'negative_balances' AS check, COUNT(*) FROM wallet.wallet_balances WHERE balance < 0
UNION ALL
SELECT 'ledger_imbalances', COUNT(*) FROM (
  SELECT lt.id
  FROM wallet.ledger_transactions lt
  JOIN wallet.ledger_entries le ON le.transaction_id = lt.id
  GROUP BY lt.id
  HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE -le.amount END) <> 0
) s
UNION ALL
SELECT 'jobs_without_tenant', COUNT(*) FROM platform.jobs WHERE tenant_id IS NULL
UNION ALL
SELECT 'outbox_without_tenant', COUNT(*) FROM platform.outbox_events WHERE tenant_id IS NULL;"
```

Expected:

```text
negative_balances      0
ledger_imbalances      0
jobs_without_tenant    0
outbox_without_tenant  0
```

### Task 7.5 - Re-run adversarial repros

Required repros:

- Unsigned internal service request with `INTERNAL_AUTH_REQUIRED=true` returns `401`.
- Cookie-authenticated mutation without `X-Csrf-Token` returns `403`.
- `/api/state` third request returns `429` when `STATE_RATE_LIMIT_MAX=2`, even if a general route was hit first.
- Login brute-force buckets differ by trusted client IP.
- Tenant 2 auth audit events are written under tenant 2.

Expected:

- Every old failure is now impossible through the public or internal HTTP surface.
- Every old failure has a regression test.

## Priority Order

1. Epic 1 - Enforce internal service authentication.
2. Epic 2 - Enforce CSRF on cookie-authenticated mutations.
3. Epic 3 - Fix rate-limit bucket isolation.
4. Epic 4 - Use real client IP for login brute-force protection.
5. Epic 5 - Tenant-scope security audit events.
6. Epic 6 - Update documentation and readiness claims.
7. Epic 7 - Final verification pass.

## Go/No-Go After Completion

Demo readiness:

- GO if the smoke test and browser UI check pass.

Investor diligence:

- GO if all epics above are complete, documented, and test-backed.

Production money movement:

- STILL NO-GO until infrastructure controls are also complete:
  - managed secrets manager
  - cloud Postgres with PITR
  - WAF or equivalent edge protection
  - mTLS or private network isolation for internal services
  - centralized logs and metrics
  - alerting on auth failures, dead-letter jobs, relay failures, and DB invariant violations
  - CI/CD deployment gates
  - real provider integrations and sandbox certification evidence
