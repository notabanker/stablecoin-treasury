# V5 Completion Report — Production Hardening

## Summary

All 5 epics delivered. 83 tests passing. Production boot gate blocks startup with unsafe defaults. Security posture strengthened with rate-limited login, secure cookies, security audit events, and demo credential gate. Full observability, demo script, and deployment docs.

## Files Changed

**New files (11):**
- `packages/shared/config.mjs` — production config validator
- `scripts/check-prod-config.mjs` — CLI config check
- `tests/unit/config.test.mjs` — config validator tests (8 tests)
- `.github/workflows/ci.yml` — CI pipeline
- `docs/RUNBOOKS.md` — operational runbooks
- `docs/DEMO_SCRIPT_V5.md` — 7-minute investor demo script
- `docs/ENVIRONMENT.md` — env var reference
- `docs/BACKUP_RESTORE.md` — backup/restore guide
- `docs/RELEASE_CHECKLIST.md` — pre-deployment checklist

**Modified files (13):**
- `services/*/src/index.mjs` (9 services) — wired config validation at startup
- `services/job-worker/src/index.mjs` — worker metrics (claimed/completed/failed/deadLettered)
- `services/relay-worker/src/index.mjs` — metrics endpoint enriched
- `packages/shared/auth.mjs` — login rate limiter, security audit events, session cookie Secure flag, CSRF cookie Secure flag
- `services/api-gateway/src/index.mjs` — login rate limiter + security audit integration
- `packages/shared/config.mjs` — demo credential gate
- `.env.example` — updated with all V5 config options
- `package.json` — added `check:prod-config` integration

## Tests

- **83 tests passing**: 46 unit (incl. 8 new config tests) + 33 integration + 4 concurrency
- `npm run check` passes (syntax + migration lint + prod config check)
- `npm run smoke` passes

## Manual Checks

| Check | Result |
|---|---|
| Negative wallet balances | 0 |
| Unbalanced ledger transactions | 0 |
| Null tenant_id in platform.jobs | 0 |
| Null tenant_id in platform.outbox_events | 0 |

## Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Rate limiter is in-memory (lost on restart) | Low | Acceptable for single-process deployment; Redis replacement documented for scale |
| No production secrets manager | Medium | Env vars only; production needs Vault/cloud secrets |
| No WAF / DDoS protection | Medium | Must be at ingress (cloud LB / Cloudflare) |
| Session cookies lack `__Host-` prefix | Low | SameSite=Lax mitigates most attacks |
| No mTLS for internal service traffic | Low | Services bind to 127.0.0.1 only |
| CI workflow not tested in GitHub Actions | Medium | Syntax/format verified locally; PR-triggered run will validate |
| No OIDC / SSO integration | Medium | Local login only; OIDC planned for post-V5 |
| No hardware-based key storage | Low | HMAC secrets are env-string based |

## Readiness Verdict

| Verdict | Status | Notes |
|---|---|---|
| **Demo ready** | ✅ | 7-minute script covers full lifecycle + tenant isolation + repair + audit |
| **Investor diligence ready** | ✅ | Architecture docs, security model, runbooks, deployment readiness, CI |
| **Production money-movement ready** | ⚠️ No | Production boot gate works but actual production deployment requires: secrets manager, WAF, cloud-managed Postgres with PITR, mTLS or service mesh, real provider integrations. The code is hardened; the infrastructure is not yet productionized. |

The platform is structurally sound for production if deployed behind a cloud ingress with managed Postgres, proper secrets injection, and WAF. The application layer has no known safety gaps for money movement — ledger is append-only double-entry, payment state machine is DB-enforced, all side effects are durable via outbox, auth/RBAC is implemented, tenant isolation is enforced.

## V5.1 Addendum — Remaining Verified Gaps Closed (2026-07-04)

The five gaps from `docs/V5_REMAINING_GAPS_FIX_INSTRUCTION.md` are fixed with regression coverage:

| Gap | Old behavior (reproduced) | New behavior | Proof |
|---|---|---|---|
| Logout bypasses CSRF (HIGH) | Cookie-only `POST /api/logout` without `X-Csrf-Token` returned 200 | Returns `403 csrf_invalid`; with correct header returns 200 | 2 integration tests in `tests/integration/auth-rbac.test.mjs` |
| Null-CSRF sessions can mutate (HIGH) | Session with `csrf_token=NULL` could `POST /api/payments` | `verifyCsrf` rejects empty/null session tokens → `403 csrf_invalid` | Integration test (DB-nulled session) + 3 unit tests in `tests/unit/auth.test.mjs` |
| Failed-login audit uses default tenant (MEDIUM) | Tenant-2 failed login / lockout audited under tenant 1 | Known emails audited under their own tenant; unknown emails fall back to the default platform tenant (documented in `docs/ENVIRONMENT.md`) | 3 integration tests (failed login, lockout, unknown email) |
| Rate limiter ignores trusted forwarded IP (MEDIUM) | Buckets always keyed by socket IP | Buckets keyed by canonical client IP (`TRUST_PROXY_HEADERS`-aware); spoofed `X-Forwarded-For` still ignored by default | 2 integration tests (trusted / untrusted) |
| Missing regression coverage (MEDIUM) | Suite green but gaps untested | 9 integration + 3 unit tests added; adversarial probes added to `docs/RELEASE_CHECKLIST.md` | `npm run test:all` — 95 tests passing |

Notes:
- `identity.sessions.csrf_token` stays nullable at the schema level; enforcement is strict at
  runtime. Rationale in `docs/ENVIRONMENT.md` (§ CSRF Sessions).
- Multi-tenant duplicate emails (schema allows the same email in two tenants) still authenticate
  by password match across candidate rows; audit attribution for ambiguous emails resolves to the
  lowest tenant id deterministically.
- Current totals: **95 tests passing** (49 unit + 42 integration + 4 concurrency).
