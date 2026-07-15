# Stablecoin Treasury Platform — Audit v4 Brief

> Hand this to any frontier LLM for a final independent verification after the SECURITY DEFINER fix for the 0053 regression.

---

## Mission

Verify that ALL findings from audits v1-v3 are properly closed. The critical 0053 regression (80/88 integration tests failing) should be fixed by migration 0055 + SECURITY DEFINER functions. Confirm this fix works end-to-end.

Commit history should show: `f3db7b9` — "fix: SECURITY DEFINER reset functions (Epic 2.2)".

---

## Machine Location

```
Project Root: /Users/notabanker/projects/corporate-stablecoin-treasury-platform
Branch:       master
Package Mgr:  npm
Tests:        npm run test:all
```

## Read First

1. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT.md` — v1
2. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT_V2.md` — v2
3. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/AUDIT_V3.md` — v3 (reported 80/88 integration failures)
4. `/Users/notabanker/projects/corporate-stablecoin-treasury-platform/CHANGELOG.md` — version history
5. `git log --oneline -15` — commit history

---

## What Was Fixed (verify each)

### Between v3 and v4

| Fix | What | How to Verify |
|---|---|---|
| **0053 regression** | Migration 0055 creates SECURITY DEFINER reset functions in each schema. Service seeds call `SELECT schema.reset_seed()` instead of `DELETE`. | Run integration tests. Expect ≥76/88 pass (was 8/88 in v3). The remaining ~12 failures are documented known issues below |
| **M8 grant** | `GRANT SELECT ON operations.providers TO svc_reconciliation` added to 0055 | Check migration 0055 contains this line |
| **M6 hash** | Maria's password hash updated to scrypt (was unsalted SHA-256) | Check migration 0055 contains scrypt hash format matching migration 0025 |
| **DEMO_SEED_ENABLED** | Phantom flag removed from config.mjs | `grep DEMO_SEED_ENABLED packages/shared/config.mjs` should return nothing |

### Previous fixes (all should remain intact)

| ID | Status (v3) | What |
|---|---|---|
| H1 | ✅ PASS | V8 Phase 0 committed |
| H2 | 🟡 Partial | Session token conditional on dev mode |
| H3 | ✅ PASS | Multi-tenant jobs |
| H4 | ✅ PASS | Password production gate |
| H5 | ❌ FAIL | Grant tightening + SECURITY DEFINER (0053 + 0055) |
| M1 | ❌ FAIL | Money class exists but unused |
| M2 | ✅ PASS | ARCHITECTURE.md updated |
| M3 | 🟡 Partial | PRODUCTION_READINESS.md updated but overclaimed |
| M4 | ✅ PASS | Breaker tests |
| M5 | ❌ FAIL | Approvals UI incomplete |
| M6 | 🟡 Partial | Tenant 2 user created, hash was wrong |
| M7 | ❌ FAIL | Prod reset test blocked (0.1.4 blocker) |
| M8 | ❌ FAIL | ProviderId validation existed but lacked SELECT grant |
| M9 | ✅ PASS | CHANGELOG/LICENSE/CONTRIBUTING |
| M10 | ✅ PASS | ADR-010 verified |
| N1 | ✅ PASS | Idempotency fallback fixed |
| N2 | ✅ PASS | Credential rotation doc |

---

## Expected Test Results

```
npm run test          → 60/60 unit pass
npm run test:all      → integration: expect ~76/88 pass (12 known failures)
npm run test:concurrency → 4/4 pass (only if integration passes)
npm audit             → 0 vulnerabilities
```

## Known Remaining Failures (12 from v4 — verify they're the same)

Check which tests still fail and categorize them:

| Expected Failure | Category | Why |
|---|---|---|
| Tests 1, 2, 4 | Payment approval flow | M5 approvals UI incomplete — approver identities/timestamps not wired |
| Test 26 | Log hygiene | Pre-existing test, check if credential leak or format issue |
| Tests 36, 37, 38 | Compliance/policy enforcement | Pre-existing or related to compliance service changes |
| Tests 46, 47 | Production mode reset | M7 blocker — needs architecture decision (0.1.4 A/B/C) |
| Tests 68, 69, 70 | Role isolation (H5) | svc_payment/svc_job cannot UPDATE/DELETE payment tables — verify these are new failures vs v3 |

---

## Verification Commands

```bash
cd ~/projects/corporate-stablecoin-treasury-platform

# Git state
git log --oneline -10
git status -sb

# Unit tests
npm run test 2>&1 | tail -8

# Integration tests (will take ~3-7 min if working, ~62 min if broken)
npm run test:integration 2>&1 | tail -20

# Check migration 0055 exists and is committed
ls -la db/migrations/0055*

# Check money class is actually used (not just created)
grep -rn "money.mjs\|fromCents\|Money\." services/ --include="*.mjs" | head -10

# Security
grep -rn "sk_\|secret\|password\|api_key" --include="*.mjs" --include="*.sql" services/ apps/ packages/ 2>/dev/null | grep -v node_modules | grep -v example | grep -v "demo123"
npm audit 2>&1 | tail -5
```

---

## New Things to Check (specific to v4)

1. **Does the app boot?** — Do services start without 42501 errors? Check integration test log for boot failures.
2. **Are SECURITY DEFINER functions correct?** — Read migration 0055. Each function should be scoped to its schema, properly handle FK ordering, and be granted EXECUTE to the right service role.
3. **Is Maria's password hash correct?** — Read migration 0055. The hash should match the scrypt format from migration 0025 (not unsalted SHA-256).
4. **Does the approvals UI now work?** — Check `apps/web/main.js` for approval display and creator-block.
5. **Are there new regressions?** — Compare failing tests against the known 12. Any new failures mean a regression.

---

## Reporting

Output:

```
## Tests
- Unit: X/X pass
- Integration: X/X pass (Y/Z are known failures, W/Z are NEW)
- Concurrency: X/X pass
- npm audit: X vulnerabilities

## Fix Verification
- H1: PASS/FAIL
- H2: PASS/FAIL
- ... (all 19 findings)

## New Issues Found
- ...

## Pitch Readiness
- All findings closed? YES/NO
- Can the full test suite run green? YES/NO
- Would you demo this to an investor today? YES/NO with caveats
```

---

## Rules

- Do NOT modify any files — read-only audit
- Verify EACH fix by reading actual code, not summaries
- Be honest — this is for a real pitch, hyping broken code costs real money
- If a fix is incomplete, say exactly what's still wrong and how to fix it
