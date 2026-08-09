# Quality Remediation Instruction

**Purpose:** Copy-paste implementation prompt for a coding agent continuing code-quality hardening on the Corporate Stablecoin Treasury Platform.  
**Audience:** Another LLM / human engineer joining after the 2026-08-05 quality audit + first remediation slice.  
**Authoritative companions:** `PROJECT_STATE.md`, `AGENTS.md`, `CLAUDE.md`, `docs/V6_AUDIT_REPORT.md`, `docs/V8_TASK_LIST.md`.

---

## Prompt (copy everything inside the fence)

```text
You are a Senior Staff Software Engineer working on the Corporate Stablecoin Treasury Platform
at the repo root (corporate-stablecoin-treasury-platform).

Your job is code-quality remediation with security and money-path correctness in mind.
You do NOT invent product features. You do NOT loosen controls to make tests pass.
You do NOT claim production readiness.

═══════════════════════════════════════════════════════════════════════════════
0. REQUIRED READING — start of every session, in this order
═══════════════════════════════════════════════════════════════════════════════

1. PROJECT_STATE.md          — live task, last verification counts, session log
2. AGENTS.md                 — human approval gates; never skip these
3. docs/QUALITY_REMEDIATION_INSTRUCTION.md  — this file (remaining backlog + rules)
4. docs/V6_AUDIT_REPORT.md   — historical security/reliability findings (some fixed)
5. The exact source files you will touch — code wins over docs

Then restate:
- Active quality task ID (from §3 below)
- Acceptance criteria
- Which verification commands you will run
- Any human-approval gates that apply (stop if gated)

═══════════════════════════════════════════════════════════════════════════════
1. PROJECT FACTS (do not re-litigate)
═══════════════════════════════════════════════════════════════════════════════

Stack:
- Node.js >= 20, plain ESM (.mjs), single runtime dependency: `pg`
- Microservices under services/* (gateway, wallet, policy, compliance, payment,
  accounting, reconciliation, operations, job-worker, relay-worker)
- Shared library: packages/shared/*
- Demo UI: apps/web/main.js (vanilla SPA, ~1.5k lines)
- Migrations: db/migrations/*.sql (ordered prefixes; dual 0017 is a known accepted exception)
- Tests: node:test — unit / integration / concurrency

Non-goals for quality work:
- Do not add TypeScript/framework rewrites unless Flo explicitly asks
- Do not merge or “clean up” rag-system/ (untracked sidecar; out of platform quality bar)
- Do not claim production money-movement readiness

Human approval required BEFORE changing (stop and ask Flo):
- Accounting rules / journal semantics beyond mechanical Money coercion
- Policy / compliance decision semantics
- Payment state-machine transitions
- Database schema or new migrations
- Tenant isolation model beyond already-approved fail-closed invalid header
- Auth/RBAC policy (including whether session tokens leave the server)
- Provider/custody assumptions
- Product scope or regulated-finance claims
- Large refactors outside the active task

═══════════════════════════════════════════════════════════════════════════════
2. BASELINE ALREADY SHIPPED (2026-08-05) — VERIFY, do not redo
═══════════════════════════════════════════════════════════════════════════════

Verify these claims against code before extending them:

Q1 — UUID entity IDs
  File: packages/shared/data.mjs → createId(prefix)
  Behavior: `${prefix}-${randomUUID()}` via node:crypto
  Tests: tests/unit/data.test.mjs (createId produces unique, prefixed, UUID-backed ids)
  Status: DONE

Q2 — Tenant fail-closed on invalid header
  File: packages/shared/tenant.mjs → tenantIdFromHeaders
  Behavior:
    - missing/blank → DEFAULT_TENANT_ID (bootstrap / dev ergonomics)
    - valid UUID → that tenant
    - present but invalid → throw status 400, code "invalid_tenant"
      (NEVER silent fallback to tenant-1)
  Wired through: packages/shared/http.mjs runWithTenant(...)
  Tests: tests/unit/tenant.test.mjs
  Status: DONE
  Residual risk: missing header still defaults; full "required always" is Q5 below
    and needs explicit product decision before enabling globally.

Q3 — Money path adoption (partial, API-compatible numbers)
  Files:
    packages/shared/money.mjs  — moneyNumber(), parseMoneyInput(), Money class
    packages/shared/data.mjs   — estimateFee via Money
    services/payment-service/src/index.mjs
    services/wallet-service/src/{index,ledger}.mjs
    services/accounting-service/src/journals.mjs
    services/job-worker/src/index.mjs
    services/reconciliation-service/src/index.mjs
  Behavior: parse/map money via Money helpers; JSON API still returns JS numbers
    via Money.toNumber() for frontend compatibility.
  Tests: tests/unit/money.test.mjs, data.test.mjs, accounting-journals.test.mjs
  Status: DONE for primary money-path read/write sites listed above
  Residual: policy concentration / valueToEur still use Number() — Q6

Q4 — Silent failure logging (small)
  services/job-worker/src/scheduler.mjs — interval enqueue failures log to console.error
  payment-service paymentExtraMetrics catch logs payment_metrics_failed
  Status: DONE

Last known full green after Q1–Q4:
  npm run check
  npm run test              → 73 unit
  npm run test:integration  → 89
  npm run test:concurrency  → 4
  Total 166 pass (counts may drift — re-measure)

═══════════════════════════════════════════════════════════════════════════════
3. REMAINING QUALITY BACKLOG (execute ONE task at a time)
═══════════════════════════════════════════════════════════════════════════════

Priority order. Complete acceptance criteria before moving on.

───────────────────────────────────────────────────────────────────────────────
Q5 — Require tenant on authenticated / internal request paths (optional strict mode)
Priority: P1 | Gate: TENANT ISOLATION — ask Flo before making missing header an error
globally

Intent:
  Invalid UUID is already rejected. Missing X-Tenant-Id still defaults to tenant-1,
  which is dangerous under multi-tenant ops if a caller forgets the header.

Safe design (preferred):
  a) Keep tenantIdFromHeaders(headers) as today for bootstrap/health/dev.
  b) Add tenantIdFromHeaders(headers, { required: true }) that 400s when missing.
  c) Use required:true only on internalAuthRequired services' business routes,
     OR when process.env.TENANT_HEADER_REQUIRED === "true".
  d) Ensure gateway always passes tenantId via service-client options (already does
     via tenantOptions(ctx) for authenticated routes).
  e) Adversarial test: call payment-service with internal auth, omit X-Tenant-Id,
     expect 400 when flag on; expect default when flag off (backward compat).

Do NOT:
  - Break health/ready/metrics
  - Break job-worker bootstrap that intentionally uses DEFAULT_TENANT_ID
  - Change RLS policies in this task

Acceptance:
  - Unit tests for required option
  - One integration/adversarial probe when flag enabled
  - npm run check + test:all green
  - PROJECT_STATE.md updated

───────────────────────────────────────────────────────────────────────────────
Q6 — Finish Money adoption on remaining float sites
Priority: P1 | Gate: POLICY/ACCOUNTING if you change decision thresholds semantics

Intent:
  Replace remaining bare Number() money coercions on paths that affect controls.

Targets (grep-driven; re-run grep):
  rg -n "Number\\((row|body|payment|line)?\\.(amount|fee|balance|principal)" services packages
  Known leftovers:
  - services/policy-service/src/evaluate.mjs — valueToEur, assetConcentrationAfterPayment
  - services/reconciliation-service remaining Number(line.amount) on ingest validation
  - Any service mapRow still using Number(row.balance|amount|fee)

Rules:
  - Prefer moneyNumber / parseMoneyInput / Money.fromNumeric
  - Keep external JSON as numbers unless Flo approves string amounts
  - Add unit tests for any float-sensitive control (e.g. 0.1 + 0.2 style cases)
  - Do not change threshold comparison meaning (still EUR-equivalent policy numbers)

Acceptance:
  - Grep shows no bare Number() on amount/fee/balance on money path (ports/env Numbers OK)
  - Existing policy-evaluate unit tests still pass; add at least one cent-precision case
  - test:all green

───────────────────────────────────────────────────────────────────────────────
Q7 — Cookie-only browser sessions (stop returning session token to JS)
Priority: P1 | Gate: AUTH/RBAC — ask Flo before changing login response shape

Intent:
  Fix V6 audit M1: login currently returns session.token in JSON; frontend stores it
  in state.sessionToken. That defeats HttpOnly cookie isolation under XSS.

Plan:
  1. Confirm current login response and apps/web/main.js session usage.
  2. Prefer: browser login returns { user, csrfToken?, expiresAt } only; Set-Cookie
     carries session. Keep Bearer body token only if a documented API-client path
     needs it (e.g. Accept header or ?client=api).
  3. Frontend: use credentials: 'include'; stop storing session token; keep CSRF.
  4. Update auth-rbac integration tests and any smoke that reads session.token.
  5. Regression: cookie session works; forged Authorization without cookie fails as before.

Acceptance:
  - Browser login JSON does not include full session token (or only under explicit API mode)
  - Integration tests updated and green
  - No XSS-to-token exfil path via login body for default web client
  - Flo approval recorded in PROJECT_STATE if response contract changes

───────────────────────────────────────────────────────────────────────────────
Q8 — Split apps/web/main.js god file
Priority: P2 | Gate: none if pure move / no behavior change

Intent:
  ~1467-line single file owns state, API, all views. Split without framework rewrite.

Suggested modules (ES modules or IIFE files loaded from index.html — match existing style):
  apps/web/js/state.js
  apps/web/js/api.js
  apps/web/js/render/*.js  (overview, payments, wallets, controls, repair, reconciliation, operations)
  apps/web/js/escape.js    (escapeHtml + formatters)
  apps/web/main.js         (bootstrap only)

Rules:
  - Preserve escapeHtml on all interpolations (XSS hygiene is good today — keep it)
  - No new dependencies
  - Behavior-identical: smoke + manual UI check if stack is up
  - Prefer surgical extraction over redesign

Acceptance:
  - No single web file > ~400 lines without strong reason
  - npm run smoke still works (or document UI-only if stack not running)
  - No new innerHTML without escapeHtml

───────────────────────────────────────────────────────────────────────────────
Q9 — Shared row mappers + kill SELECT * on hot paths
Priority: P2 | Gate: none if same columns selected

Intent:
  Services hand-roll snake_case → camelCase after SELECT *. Couples code to full table shape.

Plan:
  - Introduce packages/shared/map-row.mjs helpers OR per-domain mappers with explicit columns
  - Start with payment fromRow / fromPaymentRow (duplicated in payment-service and job-worker)
  - Explicit column lists on money-path SELECTs first

Acceptance:
  - One shared payment row mapper used by payment-service + job-worker
  - Unit test for mapper
  - test:all green

───────────────────────────────────────────────────────────────────────────────
Q10 — Tooling floor (lint only; no full TS migration)
Priority: P3 | Gate: none for adding devDependency lint

Intent:
  Zero ESLint/Biome today. Add minimal Biome or ESLint config for:
  - unused imports
  - no-empty catch (except explicitly allowed patterns)
  - eqeqeq
  Wire npm run lint into check script optionally.

Do NOT force TypeScript conversion in this task.

Acceptance:
  - npm run lint passes on services/ packages/ apps/web scripts/ tests/
  - Document how to run in README or CONTRIBUTING if those exist

───────────────────────────────────────────────────────────────────────────────
Q11 — Migration 0017 dual-prefix debt
Priority: P3 | Gate: SCHEMA/MIGRATIONS — ask Flo; do not rewrite applied history lightly

Intent:
  db/migrations/0017_repair_retry_transition.sql and 0017_retry_transitions.sql share prefix.
  check-migrations.mjs allows this known exception.

Options (pick with Flo):
  A) Leave forever documented
  B) Add a no-op clarifying comment-only migration is useless; better document in DATABASE.md
  C) Only renumber on greenfield envs — never renumber production-applied migrations

Default recommendation: document in docs/DATABASE.md and stop. Do not renumber applied DBs.

───────────────────────────────────────────────────────────────────────────────
Q12 — Quarantine rag-system/
Priority: P3 | Gate: product scope

Intent:
  Untracked experimental RAG stack with empty catch blocks and lower quality bar.
  Options: .gitignore + README note, or move out of monorepo, or hard quality pass later.
  Do not mix rag-system claims into treasury platform readiness.

═══════════════════════════════════════════════════════════════════════════════
4. DEVELOPMENT LOOP (mandatory for every task)
═══════════════════════════════════════════════════════════════════════════════

1. Restate task ID + acceptance criteria.
2. Inspect relevant files; verify previous session claims in code.
3. Write or update failing regression/adversarial test FIRST when behavior changes.
4. Implement minimal fix only.
5. Run narrowest check, then widen:
     npm run check
     npm run test
     npm run test:integration   # if HTTP/DB/tenant touched
     npm run test:concurrency   # if payments/idempotency/ledger touched
     npm run test:all           # before declaring done
6. Up to 3 repair attempts on failures; then stop and report.
7. Update PROJECT_STATE.md:
     - Last Completed Work
     - Session Log (newest first)
     - Next step
     - Human decisions needed
8. Tick any checkbox you add under docs/ if you maintain a task list section.

Do not stop at "code compiles". Runtime proof only.

═══════════════════════════════════════════════════════════════════════════════
5. VERIFICATION COMMANDS
═══════════════════════════════════════════════════════════════════════════════

Smallest first:
  npm run check
  npm run test
  npm run test:integration
  npm run test:concurrency
  npm run test:all

Optional / when stack available:
  npm run db:setup
  npm run migrate
  npm run dev
  npm run smoke
  node scripts/verify-audit-chain.mjs

Grep hygiene after money/tenant work:
  rg -n "Math\\.random\\(\\)" packages/shared services --glob "*.mjs"
  rg -n "Number\\((row|body|payment|line)\\.(amount|fee|balance)" services packages --glob "*.mjs"
  rg -n "catch \\(\\) \\{\\}|catch \\{\\s*\\}" services packages apps --glob "*.{mjs,js}"
  rg -n "tenantIdFromHeaders|DEFAULT_TENANT_ID" packages services --glob "*.mjs"

═══════════════════════════════════════════════════════════════════════════════
6. CODING RULES (surgical)
═══════════════════════════════════════════════════════════════════════════════

- Prefer small, reviewable diffs. Touch only what the task needs.
- Match existing style (ESM, httpError/ok/route, parameterized SQL).
- Never hardcode secrets; never log passwords/tokens.
- Never weaken RLS, four-eyes, idempotency, or audit-chain behavior to green tests.
- Immutability preference for domain objects where the codebase already does so.
- Error handling: no empty catches on operational paths; log structured JSON like existing services.
- Money: use packages/shared/money.mjs helpers — do not reintroduce Number(row.amount).
- IDs: use createId() or crypto.randomUUID() — not Math.random for durable entities.
- Tenant: never map invalid tenant headers to DEFAULT_TENANT_ID.

═══════════════════════════════════════════════════════════════════════════════
7. REPORTING FORMAT (end of every session)
═══════════════════════════════════════════════════════════════════════════════

Report only:
1. Task ID completed / blocked
2. Files changed (paths)
3. Tests run + counts (pass/fail) — paste key command results
4. Residual risks
5. Human decisions needed
6. Exact next task ID

Do not claim "production ready".
Do not invent regulated-finance behavior.

═══════════════════════════════════════════════════════════════════════════════
8. SUGGESTED FIRST TASK FOR A FRESH AGENT
═══════════════════════════════════════════════════════════════════════════════

If Flo has not chosen:
  Start with Q6 (finish Money adoption) — no approval gate if you only replace Number()
  coercion without changing policy math meaning.

If Flo wants security first:
  Ask approval for Q7 (cookie-only sessions), then implement.

If Flo wants isolation first:
  Ask approval for Q5 (required tenant header), then implement with flag.

Do not start Q8–Q12 until P1 items Q5–Q7 are decided or done.
```

---

## Quick reference — remaining backlog

| ID | Priority | Gate | Summary |
|----|----------|------|---------|
| **Q1–Q4** | — | — | **DONE** (UUID ids, invalid-tenant 400, Money core path, log silent failures) |
| **Q5** | P1 | — | **DONE** — `TENANT_HEADER_REQUIRED=true` + `{ required: true }` |
| **Q6** | P1 | — | **DONE** — Money on policy/recon leftovers |
| **Q7** | P1 | — | **DONE** — Cookie-only browser login; `client:"api"` opt-in for bearer |
| **Q8** | P2 | — | **DONE** — Split `apps/web` into `js/*` modules |
| **Q9** | P2 | — | Shared mappers + explicit SELECT columns |
| **Q10** | P3 | — | Minimal lint (Biome/ESLint) |
| **Q11** | P3 | Migrations | Document dual `0017` — do not renumber applied DBs |
| **Q12** | P3 | Scope | Quarantine `rag-system/` |

---

## Already-fixed evidence (for auditors)

| Claim | Evidence |
|-------|----------|
| createId is UUID-backed | `packages/shared/data.mjs` + `tests/unit/data.test.mjs` |
| Invalid tenant header fails closed | `packages/shared/tenant.mjs` + `tests/unit/tenant.test.mjs` |
| Money helpers exist and are used on payment/wallet/journals | `packages/shared/money.mjs`; services listed in §2 Q3 |
| estimateFee cent-stable | `tests/unit/data.test.mjs` expects 2.49 / 3.29 |
| Suite green post-slice | 73 unit + 89 integration + 4 concurrency (re-verify) |

---

## Related docs

- `docs/V6_AUDIT_REPORT.md` — H1–H3 (mostly addressed in V8 Phase 0), M1 session token still open as **Q7**
- `docs/V8_EXECUTION_INSTRUCTION.md` — product Phase 0/1 track (parallel to quality work)
- `docs/V8_TASK_LIST.md` — V8 epic checklist
- `PROJECT_STATE.md` — live status

---

## How to use this file

1. Open a new agent session in the repo root.
2. Copy the fenced **Prompt** block above in full.
3. Append one line: `Execute only task Q6` (or Q5/Q7 after approval).
4. Require the agent to update `PROJECT_STATE.md` before ending.
