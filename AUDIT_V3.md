# Stablecoin Treasury Platform — Audit v3 Brief

> Hand this to any frontier LLM for an independent re-audit after closing all 19 findings from audits v1+v2.

---

## Mission

Verify that ALL 19 findings from audits v1 and v2 are properly closed. Do NOT trust any summary — verify every fix by reading the actual code, running the actual tests, and probing edge cases. Find any NEW issues the previous audits missed.

---

## Machine Location

```
Project Root: /Users/notabanker/projects/corporate-stablecoin-treasury-platform
Branch:       master (latest commit should include all 19 fixes)
Package Mgr:  npm
Tests:        npm run test:all (includes unit + integration + concurrency)
```

## First Read These (in order)

1. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT.md` — v1 audit (reference)
2. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT_V2.md` — v2 audit (reference)
3. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/PROJECT_STATE.md` — current state
4. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/CHANGELOG.md` — what changed
5. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/git log --oneline -15` — commit history

---

## What Was Supposed to Be Fixed (verify each)

### 🟠 High (5)

| ID | Issue | File(s) | How to Verify |
|---|---|---|---|
| H1 | V8 Phase 0 committed | Working tree | `git log` should show migrations 0050-0052 committed (not untracked). Check `db/migrations/0050*` through `0052*` exist and are committed |
| H2 | Session token in login body | `services/api-gateway/src/index.mjs:207` | Read the login handler. Dev mode (no PRODUCTION_MODE): body should include `token`. PRODUCTION_MODE=true: body should NOT include `token` (only csrfToken + expiresAt). Verify with a test |
| H3 | Background jobs multi-tenant | `services/job-worker/src/index.mjs:96,160` | Read the file. Should query all active tenants from DB, not hardcode DEFAULT_TENANT_ID. Run tests to confirm |
| H4 | SERVICE_DB_PASSWORD production gate | `packages/shared/config.mjs`, `scripts/check-prod-config.mjs` | Read `validateProductionConfig`. Should check SERVICE_DB_PASSWORD != 'service-dev-password'. Run unit tests |
| H5 | Tightened blanket grants | `db/migrations/0053_tighten_blanket_grants.sql` + tests | Read migration 0053. Should REVOKE UPDATE/DELETE on audit_events, payment_events, payment_approvals, ledger tables. Run integration tests for role isolation |

### 🟡 Medium (12)

| ID | Issue | How to Verify |
|---|---|---|
| M1 | Float to Decimal | Check `packages/shared/money.mjs` exists. Contains `Money` class using BigInt. Services use it instead of `Number(row.amount)` |
| M2 | ARCHITECTURE.md updated | Read the file. Lists 10 services (not 8). Mentions 2 tenants. Has RLS/audit-chain sections |
| M3 | PRODUCTION_READINESS.md updated | Date should be recent. Test count should be ≥132 (not 95) |
| M4 | Circuit breaker tests | Check `tests/unit/breaker.test.mjs` exists. Tests open→half-open→closed, timeout, threshold |
| M5 | Approvals UI | Check `apps/web/main.js`. Approvals list shows approver name + timestamp. Creator's own payment has disabled approve button. Calls GET `/api/payments/:id/approvals` |
| M6 | Second Tenant 2 user | Check `db/migrations/0054_add_tenant2_user.sql`. Adds "Maria Schmidt" (maria@nordic.corp) to tenant 2. Tenant 2 now has 2 users → 4-eyes demonstrable |
| M7 | Prod reset HTTP test | Check `tests/integration/prod-reset.test.mjs`. Boots with PRODUCTION_MODE=true, verifies POST /api/reset returns 403 |
| M8 | ProviderId tenant validation | Read `services/reconciliation-service/src/index.mjs:180`. Should validate providerId belongs to tenant |
| M9 | CHANGELOG/LICENSE/CONTRIBUTING | All 3 files exist at project root. CHANGELOG has entries. LICENSE is MIT. CONTRIBUTING has setup instructions |
| M10 | ADR-010 in-memory rate limiting | `docs/adr/ADR-010*` exists, documents single-instance decision. No code change needed |
| N1 | Idempotency fallback → 400 | Read `api-gateway/src/index.mjs`. No `randomUUID()` fallback. Missing key returns 400 "Idempotency-Key required" |
| N2 | Credential rotation docs | Check `docs/CREDENTIAL_ROTATION.md` exists. Contains credential inventory + rotation procedures |

---

## New Things to Check (additional to v1+v2)

### Integration

1. **Full test suite** — `npm run test:all` — should be ≥132 tests, all green (53 unit + 79 integration + concurrency)
2. **`npm run check`** — should pass (except documented 0017 duplicate)
3. **`npm audit`** — should be 0 vulnerabilities
4. **End-to-end payment flow** — Can you login, create a payment, approve it (with a second user), verify it settles with balanced journals? Check integration tests for this flow

### Security

5. **Secrets scan** — `grep -rn "sk_\|secret\|password\|api_key\|private_key" --include="*.mjs" --include="*.ts" --include="*.sql" services/ apps/ packages/ 2>/dev/null | grep -v node_modules | grep -v example | grep -v test`
6. **Root file hygiene** — LICENSE? CHANGELOG? CONTRIBUTING? `.gitignore` reasonable?

### Code Quality

7. **Money class usage** — Does the new `packages/shared/money.mjs` properly handle BigInt cent math? Are services actually using it?
8. **Migration hygiene** — Check migrations 0053 and 0054 apply without errors. Run `npm run db:setup` or equivalent
9. **New user works** — Can you login as `maria@nordic.corp` / `demo123`? Check migration 0054 creates the user correctly

---

## Known Issues (should still be open — verify they are)

- demo123 credentials for all seed users (documented demo choice)
- Gateway randomUUID() fallback for idempotency — should now return 400 (N1 fix)
- Restore H2 should be fixed (session token only in dev mode)

---

## Reporting

Output:

```
## Verification Results

### Tests
- Unit: X/X pass
- Integration: X/X pass
- Concurrency: X/X pass
- npm audit: X vulnerabilities

### High Findings (5)
- H1: PASS/FAIL — evidence
- H2: PASS/FAIL — evidence
- etc.

### Medium Findings (12)
- M1: PASS/FAIL — evidence
- etc.

### New Issues Found
- ...

### Readiness Verdict
- All findings closed? YES/NO
- Pitch ready? YES/NO (with caveats)
```

---

## Rules

- Do NOT modify any files — read-only audit
- Verify EACH fix by reading the actual code, not just summaries
- If a fix is incomplete, say exactly what's still wrong
- Be honest — this is for a real pitch
