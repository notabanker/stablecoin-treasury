# Stablecoin Treasury Platform — Audit v2 Brief

> Hand this to any frontier LLM for an independent re-audit of the Corporate Stablecoin Treasury Platform after the initial audit findings.

---

## Mission

Re-audit the Corporate Stablecoin Treasury Platform. The first audit (v1) found 5 HIGH and 10 MEDIUM issues — verify which have been fixed and find any NEW issues the v1 audit missed. Do NOT trust any summary or handoff — verify everything yourself by reading code and running tests.

---

## Machine Location

```
Project Root: /Users/notabanker/projects/corporate-stablecoin-treasury-platform
Branch: master (check what's committed vs uncommitted)
Package Mgr: npm
Tests: npm run test:all (includes unit + integration + concurrency)
```

---

## First Read These (in order)

1. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/PROJECT_STATE.md` — current live working memory
2. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT.md` — v1 audit results (reference, not truth)
3. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/README.md` — project overview
4. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/PRODUCTION_READINESS.md` — known gaps
5. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/docs/ARCHITECTURE.md` — service map

---

## Architecture (10 Microservices)

```
api-gateway → wallet-service
            → payment-service
            → accounting-service
            → compliance-service
            → policy-service
            → reconciliation-service
            → operations-service
            → job-worker      (background jobs)
            → relay-worker    (event relay / webhooks)
```

All services under `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/services/`.

---

## v1 Audit Findings (verify each)

### 🟠 High (should be fixed)

| # | Issue | File | How to Verify |
|---|---|---|---|
| H1 | **V8 Phase 0 uncommitted** — Money-Path-Code (Migrationen 0050-0052, Crash-Safety-Fix, Outbox-DLQ, Tenant-Resets) war uncommittet | working tree | Check `git log --oneline -10`. Are 0050/0051/0052 committed? Is submit crash-safety fix committed? |
| H2 | **Session-Token im Login-Response-Body** — XSS leaky | `services/api-gateway/src/index.mjs:207` | Read the login handler. Does it still return `session: { token, ... }` in JSON? Is there an HttpOnly cookie as alternative? |
| H3 | **Background-Jobs single-tenant** — nur Tenant 1 | `services/job-worker/src/index.mjs:96` | Read job-worker. Do payment expiry + watchdog still hardcode `DEFAULT_TENANT_ID`? |
| H4 | **Default DB-Passwort nicht geprüft** — Production-Gate umgangen | `packages/shared/config.mjs`, `scripts/check-prod-config.mjs` | Is `SERVICE_DB_PASSWORD` (default: `service-dev-password`) checked anywhere in the production gate? |
| H5 | **Blanket-Grants hebeln Append-Only auf** — SELECT/INSERT/UPDATE/DELETE ON ALL TABLES auf audit_events | `db/migrations/0033_service_roles.sql:72-121` | Read migration 0033. Are grants still blanket? Are audit/payment/approval tables protected? |

### 🟡 Medium (should be addressed)

| # | Issue | How to Verify |
|---|---|---|
| M1 | **Floats statt Decimal in JS** — `Number()` casts on monetary values | `grep -rn "Number(" services/ apps/ packages/ --include="*.mjs"` — especially in payment/wallet/accounting services |
| M2 | **ARCHITECTURE.md veraltet** — missing 2 services, wrong tenant count | Read the file, compare to actual services/ directory |
| M3 | **PRODUCTION_READINESS.md veraltet** — wrong test count (95 vs 136), stale date | Read the file, check if updated from 2026-07-04 |
| M4 | **Circuit Breaker ungetestet** | `grep -rn "breaker" tests/` — should find tests now |
| M5 | **Approvals-UI fehlt** — Governance unsichtbar | Check `apps/web/main.js` — does it render approval action buttons or just a counter? |
| M6 | **Tenant 2 nur 1 User** — 4-Augen nicht demonstrierbar | Read `db/migrations/0021_second_tenant_seed.sql` — how many users for tenant 2? |
| M7 | **0.1.4 blockiert** — kein HTTP-level prod-reset test | Check `tests/` for adversarial production-mode tests |
| M8 | **Statement-Ingest validiert providerId nicht gegen Tenant** | Read `services/reconciliation-service/src/index.mjs:180ff` |
| M9 | **Repo-Hygiene** — kein CHANGELOG, LICENSE, CONTRIBUTING, OpenAPI | Check root directory |
| M10 | **In-Memory Rate-Limiting** — akzeptiert, aber single-instance only | Verify it's still documented as intentional (ADR-010) |

---

## New Things to Check (not in v1)

### Critical Path

1. **Do ALL services start?** — `for svc in services/*/; do node "$svc/src/index.mjs" --help 2>&1 \| head -3; done` (or check package.json scripts)
2. **Can the full stack boot?** — Does `docker-compose up` work? Does the API gateway respond?
3. **Complete payment flow end-to-end** — login → create payment → approve → execute → verify in accounting → check audit trail

### Security

4. **npm audit** — `npm audit` output (should be 0 vulnerabilities like v1)
5. **Secrets scan** — `grep -rn "sk_\|secret\|password\|api_key\|private_key" --include="*.mjs" --include="*.ts" services/ apps/ packages/ 2>/dev/null \| grep -v node_modules \| grep -v "\.env" \| grep -v "example\|sample\|test\|mock\|fake"`
6. **Hardcoded credentials in migrations** — Check if any migration has hardcoded passwords

### Code Quality

7. **Error handling** — Do services return proper HTTP error codes? Any crash-on-invalid-input?
8. **Logging** — Is there structured logging? Are financial operations logged with enough context?
9. **Idempotency** — Are POST endpoints idempotent (idempotency-key pattern)?

---

## Verification Commands

```bash
cd /Users/notabanker/projects/corporate-stablecoin-treasury-platform

# Git state
echo "=== HEAD ===" && git log --oneline -5
echo "=== Working tree ===" && git status -sb
echo "=== Uncommitted files ===" && git diff --name-only HEAD

# Full test suite
echo "=== Unit ===" && npm run test 2>&1 | tail -5
echo "=== Integration ===" && npm run test:integration 2>&1 | tail -10
echo "=== Concurrency ===" && npm run test:concurrency 2>&1 | tail -10
echo "=== ALL ===" && npm run test:all 2>&1 | tail -10

# Syntax/lint
echo "=== Check ===" && npm run check 2>&1 | tail -5

# Security
echo "=== npm audit ===" && npm audit 2>&1 | tail -10
```

---

## Reporting

Output exactly this format:

```
## 🟠 High (fix before pitch)
- [NEW/VERIFIED/REOPENED] Issue description — file:line — status

## 🟡 Medium (fix before production)
- ...

## ✅ v1 Verified Fixed
- H2: ... (how you verified)

## ✅ Working Correctly
- Tests: X/X green
- Boot test: ...
- Payment flow: ...

## 🆕 New Findings (missed by v1)
- ...

## Pitch Readiness (unchanged/improved/worse)
```

---

## Rules

- Do NOT modify any files — read-only audit
- Test the order endpoint: does POST /api/payments with valid data return 200?
- Check the audit trail: is tampering detectable?
- Verify at least one HIGH fix by running specific tests
- If you find a new HIGH/critical issue, include reproduction steps
