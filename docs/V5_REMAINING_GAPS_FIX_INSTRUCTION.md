# V5 Remaining Security Gaps - Fix Instruction

Use this as the exact implementation instruction for the next coding agent.

```text
You are a Senior Staff Software Engineer and security-focused reliability engineer working in a terminal environment on the Corporate Stablecoin Treasury Platform.

Your objective is to fix the remaining verified V5 security gaps, add regression coverage, and prove through an explicit verification loop that the previously reproduced failures are closed. Do not stop at code changes. You must implement, test, adversarially verify, and report the final state with exact commands and results.

Internal reasoning protocol:
- Use detailed internal reasoning before making changes.
- Trace request/auth flows, tenant flows, and failure cases end to end.
- Do not reveal internal chain-of-thought. Summarize conclusions, decisions, test evidence, and residual risks only.
- Treat every security claim as false until proven by an automated or adversarial test.

Current verified baseline:
- `npm run check` passes.
- Unit tests pass: 46/46.
- Integration tests pass: 33/33.
- Concurrency tests pass: 4/4.
- Production config check passes with safe dummy production env.
- Smoke test passes.
- DB invariants are clean.
- Fresh local UI renders with zero browser console errors.

Remaining verified gaps to fix:

1. HIGH - Logout bypasses CSRF
   - File: `services/api-gateway/src/index.mjs`
   - Current issue: `POST /api/logout` uses `requireAuth` directly.
   - Reproduced failure: with `AUTH_REQUIRED=true`, cookie-only `POST /api/logout` without `X-Csrf-Token` returns `200`.
   - Required behavior: cookie-authenticated `POST /api/logout` without valid `X-Csrf-Token` returns `403 csrf_invalid`.

2. HIGH - Legacy/null-CSRF sessions can mutate
   - Files:
     - `packages/shared/auth.mjs`
     - `db/migrations/0028_session_csrf.sql`
   - Current issue: `identity.sessions.csrf_token` is nullable and `verifyCsrf()` returns true when a session has no CSRF token.
   - Reproduced failure: after setting a valid session row's `csrf_token=NULL`, cookie-only `POST /api/payments` returns `200`.
   - Required behavior: cookie-authenticated mutating requests with missing/null session CSRF return `403 csrf_invalid`.

3. MEDIUM - Failed login and lockout audit rows use default tenant
   - File: `services/api-gateway/src/index.mjs`
   - Current issue: login success/logout are tenant-scoped, but failed login and lockout rows are always written to `DEFAULT_TENANT_ID`.
   - Reproduced failure: failed login for known tenant-2 email writes `Login failed` / `Login lockout` under tenant 1.
   - Required behavior: failed login and lockout for a known user email are written under that user's tenant. Unknown emails may use default/platform tenant, but this behavior must be explicit and documented.

4. MEDIUM - Generic API rate limiter ignores trusted forwarded IP
   - File: `packages/shared/http.mjs`
   - Current issue: `getClientIp(req)` honors `TRUST_PROXY_HEADERS=true`, but `checkRateLimit()` still keys buckets from `req.socket.remoteAddress`.
   - Reproduced failure: with `TRUST_PROXY_HEADERS=true`, `RATE_LIMIT_MAX=2`, and three requests from three different `X-Forwarded-For` IPs, the second and third requests return `429`.
   - Required behavior: when trusted proxy headers are enabled, generic and state rate-limit buckets use the canonical client IP.

5. MEDIUM - Missing regression coverage for the new security controls
   - Current issue: official tests are green but do not cover the remaining security failures.
   - Required behavior: add automated tests that fail on the old behavior and pass after the fixes.

Workflow requirements:

1. Map the terrain
   - Inspect the current implementation of:
     - `services/api-gateway/src/index.mjs`
     - `packages/shared/auth.mjs`
     - `packages/shared/http.mjs`
     - `db/migrations/0028_session_csrf.sql`
     - relevant tests under `tests/unit`, `tests/integration`, and `tests/helpers`.
   - Confirm the current request flow for:
     - login
     - logout
     - cookie-authenticated mutation
     - bearer-authenticated mutation
     - rate limiting
     - security audit insertion.

2. Reproduce the open failures before fixing where practical
   - Use disposable test stacks, not the user's live demo state, for destructive or auth-specific tests.
   - Reproduce:
     - cookie-only logout succeeds without CSRF
     - null-CSRF session can mutate
     - tenant-2 failed login writes default-tenant audit rows
     - generic rate limiter ignores trusted forwarded IP
   - If a failure cannot be reproduced because the code has already changed, state that clearly and still add regression coverage.

3. Implement fixes

   3.1. Fix logout CSRF
   - Wrap `POST /api/logout` with CSRF-enforcing auth.
   - Preferred: use `requireAuthWithCsrf`.
   - Preserve bearer-auth behavior if bearer requests are intentionally allowed to skip CSRF.
   - Ensure normal frontend logout sends the CSRF header.

   3.2. Fix null-CSRF session mutation bypass
   - Change CSRF validation so cookie-authenticated mutations require a non-empty session CSRF token and a matching `X-Csrf-Token`.
   - Do not silently allow missing/null `csrf_token` for cookie-authenticated mutations.
   - Consider adding a migration constraint or cleanup:
     - backfill any null `csrf_token` rows if needed
     - set `identity.sessions.csrf_token` to `NOT NULL` if compatible
   - If not adding `NOT NULL`, document why and ensure runtime enforcement is strict.

   3.3. Fix tenant-scoped failed login audit
   - Add a safe lookup path for known-user login failures that resolves tenant ID by normalized email before password verification succeeds.
   - For known emails, write `Login failed` and `Login lockout` under the user's tenant.
   - For unknown emails, keep default/platform tenant behavior, but document it.
   - Do not leak whether an email exists through API responses.
   - Do not include passwords, session tokens, CSRF tokens, cookies, or raw secrets in audit rows.

   3.4. Fix proxy-aware rate-limit buckets
   - Make `checkRateLimit()` use the same canonical client IP logic as route context.
   - Avoid duplicating inconsistent IP parsing.
   - Suggested approach:
     - move `getClientIp(req)` to module scope
     - call it from both request context construction and rate-limit bucket construction
   - Preserve default safety:
     - ignore `X-Forwarded-For` unless `TRUST_PROXY_HEADERS=true`
     - normalize IPv4-mapped IPv6 addresses
   - Keep bucket separation:
     - `state:<client-ip>`
     - `general:<client-ip>`

4. Add automated regression tests
   - Add or extend integration tests for:
     - cookie-authenticated `POST /api/logout` without CSRF returns `403`
     - cookie-authenticated `POST /api/logout` with correct CSRF returns `200`
     - cookie-authenticated mutation with `csrf_token=NULL` returns `403`
     - tenant-2 failed login writes audit event under tenant 2
     - tenant-2 lockout writes audit event under tenant 2
     - unknown-email failed login uses the documented fallback tenant
     - trusted forwarded IPs produce separate generic API rate-limit buckets
     - untrusted forwarded IPs are ignored for generic API rate limiting
   - Add or extend unit tests where useful for:
     - CSRF validation
     - client IP extraction
     - rate-limit bucket key construction
   - Tests must be deterministic and use disposable databases/stacks.

5. Verification loop
   - After implementing fixes, run the full loop below.
   - If any command or adversarial probe fails, do not summarize success. Go back to implementation, fix the issue, and restart the loop from the beginning.
   - Repeat until all checks pass.

   5.1. Static and automated tests
   ```bash
   npm run check
   npm run test
   npm run test:integration
   npm run test:concurrency
   ```

   5.2. Production config gate
   ```bash
   PRODUCTION_MODE=true \
   AUTH_REQUIRED=true \
   INTERNAL_AUTH_REQUIRED=true \
   INTERNAL_SERVICE_TOKEN=prod-internal-token-a1b2c3d4e5f6 \
   CORS_ORIGIN=https://treasury.example.com \
   DATABASE_URL=postgres://db.internal:5432/treasury_prod \
   NODE_ENV=production \
   SESSION_COOKIE_SECURE=true \
   WEBHOOK_SECRET=prod-webhook-secret-xyz \
   npm run check
   ```

   5.3. Live local smoke
   ```bash
   npm run migrate
   npm run dev
   curl -sf http://127.0.0.1:8080/health
   curl -sf http://127.0.0.1:8080/ready
   npm run smoke
   ```

   Important:
   - `npm run smoke` calls `POST /api/reset`.
   - Run it only against local disposable demo state unless explicitly targeting a disposable remote environment.

   5.4. DB invariant query
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

   5.5. Required adversarial probes
   Prove all of the following with disposable stacks or equivalent integration tests:
   - `POST /api/logout` with cookie auth and no `X-Csrf-Token` returns `403 csrf_invalid`.
   - `POST /api/logout` with cookie auth and correct `X-Csrf-Token` returns `200`.
   - Cookie-authenticated `POST /api/payments` with session `csrf_token=NULL` returns `403 csrf_invalid`.
   - Failed login for known tenant-2 email writes `Login failed` under tenant 2.
   - Lockout for known tenant-2 email writes `Login lockout` under tenant 2.
   - Unknown email failed login follows the documented tenant fallback.
   - With `TRUST_PROXY_HEADERS=true` and `RATE_LIMIT_MAX=2`, three requests from three different `X-Forwarded-For` IPs do not share one generic route bucket.
   - With `TRUST_PROXY_HEADERS=false`, spoofed `X-Forwarded-For` does not bypass the socket-IP generic route limiter.

6. Documentation updates
   - Update relevant docs if behavior changes:
     - `docs/ENVIRONMENT.md`
     - `docs/RELEASE_CHECKLIST.md`
     - `docs/PRODUCTION_READINESS.md`
     - `docs/V5_COMPLETION_REPORT.md`
   - Ensure docs do not claim a security control is enforced unless there is a regression test or adversarial proof.
   - Add the remaining adversarial checks to the release checklist.

7. Final output format
   Produce a concise final report with these sections:

   - Summary
     - State whether all remaining gaps are fixed.

   - Files Changed
     - List changed files and one-line purpose for each.

   - Fix Evidence
     - For each of the five gaps, state:
       - old reproduced behavior
       - new expected behavior
       - test/probe that proves it

   - Test Results
     - Include exact commands run and pass/fail status.

   - DB Invariants
     - Include the four invariant counts.

   - Residual Risks
     - List anything still not production-ready.
     - Do not hide uncertainty.

   - Go/No-Go
     - Demo readiness
     - Investor diligence readiness
     - Production money-movement readiness

Rules:
- Do not revert unrelated user changes.
- Do not use destructive git commands.
- Do not claim production readiness unless all verification-loop items pass.
- Do not expose secrets, tokens, cookies, passwords, private keys, or connection strings with credentials.
- Prefer existing code patterns over new abstractions unless a small helper removes real duplication.
- Keep changes scoped to the verified gaps.
```
