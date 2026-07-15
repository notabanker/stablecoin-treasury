# HANDOFF — V8 Phase 0

Date: 2026-07-12 · Branch: `master` · HEAD: `a738459` · Agent: Claude (0.1.3), Codex (0.1.1 reverify + 0.1.2)
Committed: nothing from V8; all work described below remains in the working tree.

This is the fast catch-up document. The authoritative V8 set is:

1. `PROJECT_STATE.md` — live task, gates, latest verification
2. `docs/V8_FINAL_PLAN.md` — locked decisions and phase exits
3. `docs/V8_TASK_LIST.md` — stable task IDs and checkboxes
4. `docs/V8_IMPLEMENTATION_PLAN.md` — task specifications and acceptance criteria
5. `docs/V8_EXECUTION_INSTRUCTION.md` — execution order and verification loop

Supporting Phase-0 findings: `docs/V6_AUDIT_REPORT.md` and
`docs/LLM_TECHNICAL_HANDOFF_OPEN_FINDINGS.md`.

## Current posture

- V8 product direction: settlement + treasury for SMB and corporate.
- Active phase: **Phase 0 — money-path safety**.
- Phase 1 remains blocked on Phase-0 exit, Doppler setup, and Circle sandbox access.
- Locked: sevdesk first accounting connector, Doppler, Circle primary sandbox,
  G1/G2/G4/G5 approved.
- Pending: G3 and G6–G10; do not implement those scopes.
- Readiness: **Demo GO · Diligence GO with caveats · Production money movement NO-GO**.

## Scope and provenance of this handoff

The working tree contains three V8 implementation slices:

- **Inherited from opencode:** Task 0.1.1 (`ALLOW_DEMO_RESET`). Reverified by Codex.
- **Implemented by Codex:** Task 0.1.2 (tenant-scoped reseeds), its adversarial
  integration test, the config-test cache-flake repair, full verification,
  project-state/task-list updates, and the original version of this handoff.
- **Implemented by Claude:** Task 0.1.3 (`admin:reset` scope formalization) — two
  regression tests only, no permission change. Investigated Task 0.1.4 and found it
  genuinely blocked on test infrastructure (see "Exact next task" below); did not
  improvise a workaround.

No database migration, accounting rule, policy/compliance rule, payment-state-machine
semantic, identity record, or RBAC permission was changed in this session.

## Completed in this V8 working tree

### Task 0.1.1 — `ALLOW_DEMO_RESET` production gate (H1)

Status: complete and checked in `docs/V8_TASK_LIST.md`.

- `packages/shared/config.mjs`: `isDemoResetAllowed()` allows reset outside
  `PRODUCTION_MODE`; production requires exact `ALLOW_DEMO_RESET="true"`.
- `services/api-gateway/src/index.mjs`: `/api/reset` returns 403
  `demo_reset_disabled` before fan-out when the gate is closed.
- `tests/unit/config.test.mjs`: four gate cases.
- `docs/ENVIRONMENT.md`: matches runtime behavior.

### Task 0.1.2 — tenant-scoped reseeds (H2)

Status: complete and checked in `docs/V8_TASK_LIST.md`.

Flo approved these semantics on 2026-07-12:

- Reset affects only the authenticated caller's tenant.
- Tenant 1 restores the existing Vega baseline.
- Tenant 2 restores the existing Nordic baseline from migration 0023.
- Tenant-2 payments, journals, and reconciliation reset empty because no approved
  Nordic fixtures exist for those domains.
- Unknown tenants reset operational data empty and never inherit Vega IDs.
- Identity users and RBAC are not reset.
- Reset must not restart the global payment-reference sequence.

Implementation:

- `packages/shared/data.mjs`: Vega, Nordic, and empty-fallback seed profiles.
- All seven `services/{wallet,policy,compliance,payment,accounting,operations,reconciliation}-service/src/seed.mjs`
  functions now accept `tenantId` and scope all deletes/inserts/transactions to it.
- All seven service `/reset` routes derive `tenantId` from the signed internal header,
  pass it to reseed, and return caller-tenant data.
- `services/payment-service/src/seed.mjs`: removed global sequence restart.
- `tests/integration/auth-rbac.test.mjs`: tenant-2 admin reset restores Nordic data,
  clears tenant-2 transient domains, leaves tenant-1 payment/wallet/provider IDs
  unchanged, and leaves `payment_reference_seq` unchanged.

Verification after 0.1.2:

- Focused tenant-2 reset adversarial test: 1/1
- `npm run check`: pass (known grandfathered duplicate migration prefix 0017 only)
- `npm run test:all`: **130/130** — 53 unit + 73 integration + 4 concurrency
- Production-shaped `npm run check`: pass
- `npm run migrate`, live `/health`, `/ready`, and `npm run smoke`: pass
- DB invariants: negative balances 0; ledger imbalances 0; jobs without tenant 0;
  outbox without tenant 0; approval-row deficit 0
- Audit verifier: `{"ok":true,"checkedRows":9}`, exit 0
- `git diff --check`: pass; port 8080 clean after graceful shutdown

Repair made during verification: `tests/unit/config.test.mjs` used `Date.now()` as an
ESM import cache-buster, which can collide within one millisecond and made the config
suite flaky. It now uses a monotonic import nonce. Two consecutive unit runs and the
full suite passed afterward.

## Completed: Task 0.1.3 — `admin:reset` scope fix (Claude, this session)

Status: complete and checked in `docs/V8_TASK_LIST.md`. No permission changed —
`admin:reset` stays on each tenant's Admin role, per Flo's 2026-07-12 approval recorded
in the prior session (reset is already caller-tenant-scoped via 0.1.2; no
platform-operator role needed in Phase 0).

Implementation: two new tests in `tests/integration/auth-rbac.test.mjs`.
1. `"tenant-1 admin reset restores the Vega baseline and leaves tenant 2 unchanged"` —
   the symmetric mirror of the existing 0.1.2 tenant-2 test. The prior test only proved
   tenant-2→tenant-1 isolation (the historically buggy direction, H2); this proves the
   general bidirectional invariant, including that the payment-reference sequence stays
   unchanged.
2. `"admin:reset is granted only to each tenant's Admin role, not broadened to a
   platform-operator role"` — queries `identity.role_permissions` directly and asserts
   the permission is held by exactly `{tenant-1 Admin, tenant-2 Admin}`. This is the
   regression backstop for the 0.1.3 decision itself: it fails the moment `admin:reset`
   is granted anywhere broader.

Verification: narrow (2/2) → `npm run check` pass → `npm run test:all` 132/132 (53
unit + 75 integration + 4 concurrency, up from 130) → production-shaped `npm run check`
pass → migrate + dev + health/ready + `npm run smoke` pass → all 5 DB invariants
(including approvals-integrity, which the ARCHITECTURE.md 4-query block omits but
RUNBOOKS.md's canonical 5-query block includes) zero → `verify-audit-chain.mjs`
`{"ok":true,"checkedRows":10}` → dev stack stopped cleanly.

## Exact next task

Task **0.1.4 — adversarial production reset test — BLOCKED, needs Flo's decision**.

Goal: prove over real HTTP that production mode without `ALLOW_DEMO_RESET` returns 403.
This requires a live gateway that boots past `validateProductionConfig`
(`packages/shared/config.mjs:29`, called synchronously at
`services/api-gateway/src/index.mjs:17` — throws and crashes boot on failure) with a
real authenticated admin session, since `isDemoResetAllowed()` is checked inside
`perm("admin:reset")` after login + RBAC, both of which need a live DB.

The blocker: `validateProductionConfig` rejects any `DATABASE_URL` containing
`"127.0.0.1"`, `"localhost"`, or `"treasury_dev"` (a pure string check, not a
connectivity check — `config.mjs:47-51`). I tested the obvious workaround — pointing
`DATABASE_ADMIN_URL` at the IPv6 loopback (`[::1]`), which the local Postgres server
itself accepts (`psql "postgres://[::1]:5432/postgres" -c "select 1"` succeeds, and
`pg.Client({host:"::1",...})` with discrete fields succeeds) — and confirmed it does
NOT work: `pg.Client({connectionString:"postgres://[::1]:5432/postgres"})` fails with
`getaddrinfo ENOTFOUND [::1]` (a known `pg-connection-string` limitation with bracketed
IPv6). Since `tests/helpers/stack.mjs` and every service build `DATABASE_URL` as a
connection string (never discrete host/port fields), this is a real dead end, not
something more code cleverness fixes without a broader refactor.

Three options for Flo (none implemented — this is an infra/test-architecture decision):

- **A.** Point the test DB at genuinely non-local infrastructure (e.g. a Dockerized
  Postgres reachable by container hostname). Honest, but adds a new dependency
  (Docker) to the test suite.
- **B.** Add a narrow, explicitly-named test-only exception to
  `validateProductionConfig`'s DB-locality check (e.g. recognizing the
  `treasury_test_` prefix `stack.mjs` already uses). Touches the production config
  gate itself — needs sign-off even though narrow, since this is exactly the kind of
  auth/production-policy change `AGENTS.md` reserves for Flo.
- **C.** Test only the route-wiring (`perm("admin:reset")` + `isDemoResetAllowed()`
  composition) below full HTTP, skipping `validateProductionConfig` entirely. Cheaper
  but weaker — both `HANDOFF.md` and `V8_EXECUTION_INSTRUCTION.md` ask for an
  HTTP-level adversarial test specifically, and 0.1.1's unit tests already cover
  `isDemoResetAllowed()` in isolation, so this would mostly re-test what 0.1.1 already
  proved rather than closing the real gap (route wiring under a live boot).

Explicitly not done: gaming the string check with a numeric-shorthand IP (e.g.
`"127.1"`, which some resolvers treat as `127.0.0.1`) — it would pass the check while
still literally being local dev infrastructure, defeating the point of the check.

## Completed: Epic 0.2 — outbox DLQ / poison-event handling (Claude, this session, H3)

Status: 0.2.1–0.2.5 complete and checked in `docs/V8_TASK_LIST.md`; 0.2.6 (replay tool)
deferred as P1, not required for Phase 0 exit. See `PROJECT_STATE.md` session log for full
detail. Summary: `platform.outbox_events` gained `attempts`/`last_error`/`dead_lettered_at`
(migration 0050) and `next_attempt_at` for exponential backoff (migration 0051, mirroring
`platform.jobs`'s existing pattern). `recordDeliveryAttempt` in `relay-worker` was a
documented no-op before this (the H3 finding) — it now actually dead-letters after
`RELAY_MAX_RETRIES` (a constant that existed but was never wired up) and backs off
otherwise. `job-worker`'s watchdog gained a matching "Outbox dead-letter queue non-empty"
alert. New test `tests/integration/outbox-dlq.test.mjs` reproduces the exact documented
failure mode (20 permanently-failing events occupying the full `BATCH_SIZE=20` window
forever) and proves good events behind them still deliver. Full loop green: 134/134 suite,
prod-config gate, smoke, 5 invariants, audit chain.

## Completed: Epic 0.3 — provider_submissions crash-safety (Claude, this session, Gate G1, Finding 1 — CRITICAL)

Status: 0.3.1–0.3.6 complete and checked in `docs/V8_TASK_LIST.md`. Closes the CRITICAL
duplicate-external-transfer risk: `payment.provider_submissions` (migration 0052) is inserted
with a deterministic idempotency key (`payment:<id>`) before the adapter is ever called, and
every attempt (first or retry) reuses that same key so a real provider's own idempotency
guarantee prevents a duplicate transfer. Also fixes the second failure mode: a ledger-debit
failure after the provider already accepted the transfer no longer marks the payment `Failed`
(which used to silently lose the fact that external money had moved) — it now stays `Executing`
and surfaces on the existing `GET /api/repair` list. Deliberately reused the existing
`Executing`/repair mechanism instead of inventing a new payment status, to stay out of
payment-state-machine-semantics-change territory. New test `tests/integration/provider-crash-
safety.test.mjs` (2 tests) proves both properties; writing it surfaced and fixed a real latent
bug in `resolveAdapter()` (fresh adapter instance per call, silently discarding any
idempotency state across a crash+retry). Full loop green: 136/136 suite, prod-config gate,
smoke, 5 invariants, audit chain. See `PROJECT_STATE.md` session log for full detail.

After Epic 0.1/0.2/0.3, continue in this order:

1. Epic 0.2 — outbox DLQ/backoff/starvation and poison+good test (H3)
2. Epic 0.3 — `provider_submissions` crash safety (G1 approved)
3. Epic 0.4 P0 — `SERVICE_DB_PASSWORD` gate and creator≠approver DB constraint
4. Epic 0.5 — reconcile `PRODUCTION_READINESS.md`

Phase-0 exit additionally requires breaker tests, dead provider-adapter removal,
stronger saga-failure tests, the full verification bundle, and an explicit production
money-movement NO-GO fence.

## Working-tree state

No V8 commit exists. Preserve all current changes. At handoff time the branch is
`master`, HEAD is `a738459`, and the following files are changed or untracked.

### File-by-file change ledger

| File | Provenance | Exact purpose |
|---|---|---|
| `packages/shared/config.mjs` | inherited 0.1.1 | Adds `isDemoResetAllowed()`: dev allowed; production requires exact `ALLOW_DEMO_RESET=true`. |
| `services/api-gateway/src/index.mjs` | inherited 0.1.1 | Checks the production reset gate before any service fan-out. Existing `tenantOptions(ctx)` continues carrying the authenticated tenant to services. |
| `docs/ENVIRONMENT.md` | inherited 0.1.1 | Documents the exact reset-gate behavior. |
| `tests/unit/config.test.mjs` | inherited 0.1.1 + Codex repair | Contains four reset-gate tests. Codex replaced the `Date.now()` ESM cache-buster with a monotonic nonce after a full-suite failure proved same-millisecond collisions. |
| `packages/shared/data.mjs` | Codex 0.1.2 | Makes `createSeedData(tenantId)` tenant-aware; retains Vega data, adds the migration-0023 Nordic baseline, and returns empty operational fixtures for unknown tenants. |
| `services/wallet-service/src/index.mjs` | Codex 0.1.2 | `/reset` reads the signed caller tenant, reseeds that tenant, and returns only that tenant's wallets. |
| `services/wallet-service/src/seed.mjs` | Codex 0.1.2 | Scopes ledger-entry/transaction/account/wallet/asset/entity deletes and inserts to `tenantId`; passes tenant into ledger helpers and opening-balance posting. |
| `services/policy-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/policy-service/src/seed.mjs` | Codex 0.1.2 | Upserts the selected tenant's approved seed policy; deletes policy for unknown/empty tenant profiles. |
| `services/compliance-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/compliance-service/src/seed.mjs` | Codex 0.1.2 | Deletes and restores counterparties only for `tenantId`. |
| `services/payment-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/payment-service/src/seed.mjs` | Codex 0.1.2 | Scopes idempotency/event/approval/payment deletes and seed inserts to `tenantId`; removes the global `ALTER SEQUENCE ... RESTART WITH 1005` side effect. |
| `services/accounting-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/accounting-service/src/seed.mjs` | Codex 0.1.2 | Deletes and restores journal entries only for `tenantId`; Nordic/unknown profiles restore empty. |
| `services/operations-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/operations-service/src/seed.mjs` | Codex 0.1.2 | Uses a tenant-specific audit advisory lock; scopes provider/alert/audit deletes and inserts; rebuilds only that tenant's hash chain. |
| `services/reconciliation-service/src/index.mjs` | Codex 0.1.2 | `/reset` passes and returns the caller tenant. |
| `services/reconciliation-service/src/seed.mjs` | Codex 0.1.2 | Scopes FK-ordered statement-line/statement/reconciliation deletes and seed inserts to `tenantId`; Nordic/unknown profiles restore empty. |
| `tests/integration/auth-rbac.test.mjs` | Codex 0.1.2 + Claude 0.1.3 | Codex: authenticated tenant-2 reset coverage across gateway fan-out, all domain data, tenant-1 non-mutation, Nordic restoration, empty Nordic transient domains, unchanged global payment sequence. Claude: symmetric tenant-1 reset test (mirrors Codex's tenant-2 test) + RBAC-surface bite test asserting admin:reset is granted to exactly {tenant-1 Admin, tenant-2 Admin}. |
| `PROJECT_STATE.md` | inherited + Codex | Records 0.1.1 and 0.1.2 decisions, implementation, test evidence, residual risks, and next task. |
| `docs/V8_TASK_LIST.md` | prior planning + Codex + Claude | Authoritative V8 backlog; 0.1.1–0.1.3 checked complete, 0.1.4 marked BLOCKED. File remains untracked. |
| `docs/V8_FINAL_PLAN.md` | prior planning | Locked V8 decisions and phase exits; untracked. |
| `docs/V8_IMPLEMENTATION_PLAN.md` | prior planning | Full epic/task acceptance criteria; untracked. |
| `docs/V8_EXECUTION_INSTRUCTION.md` | prior planning | Execution order, gates, and verification commands; untracked. |
| `HANDOFF.md` | Codex | Replaced the stale V6-era handoff with this V8 session record. |

Run `git status --short` before editing. Do not revert, overwrite, or partially commit
these interdependent reset changes without deliberately reviewing the scope.

## What Codex did, chronologically

1. Read `PROJECT_STATE.md`, `docs/AGENT_LOOP.md`, `README.md`, `TECHNICAL_TASKS.md`,
   the authoritative V8 docs, and the H2 audit finding.
2. Inspected all seven reseed functions and service reset routes, `createSeedData()`,
   tenant propagation, migrations 0021/0023/0027, RLS context, and existing tenant tests.
3. Identified the required human choice: tenant-2-specific restore versus delete-only.
   Recommended Nordic baseline restoration with empty unseeded domains and no global
   sequence mutation. Flo approved this exact behavior.
4. Recorded the approval in `PROJECT_STATE.md` before changing tenant-isolation code.
5. Implemented tenant-specific seed profiles and parameterized all seven reset paths.
6. Added the authenticated adversarial integration test.
7. First focused-test attempt failed because the test kept a DB probe connection open
   while the disposable stack teardown terminated it (`57P01`). Repaired the test to
   use short-lived before/after sequence connections; rerun passed 1/1.
8. First full-suite attempt found a pre-existing 0.1.1 test-cache collision: the
   non-production config test reused a production-evaluated ESM module because two
   `Date.now()` cache keys matched. Replaced the timestamp with a monotonic nonce.
9. Ran unit tests twice consecutively, then the full 130-test suite successfully.
10. Ran the production-shaped config gate, migration, live stack, health/readiness,
    smoke, five DB invariants, audit verifier, graceful shutdown, and diff checks.
11. Checked Task 0.1.2 complete and updated the live project state and handoff.

## Environment and watch points

- Local URLs used in the successful loop:
  `DATABASE_ADMIN_URL=postgres://$(whoami)@127.0.0.1:5432/postgres`,
  `DATABASE_URL=postgres://$(whoami)@127.0.0.1:5432/treasury_dev`,
  `SERVICE_DB_PASSWORD=service-dev-password`.
- Local Postgres trust auth does not prove role passwords; CI is the password proof.
- Check `lsof -nP -iTCP:8080 -sTCP:LISTEN` before `npm run dev`.
- `npm run smoke` calls `/api/reset` and restores the local demo baseline.
- A stale tenant-2 `TAMPERED` audit row previously polluted `treasury_dev`; recreate or
  restore via smoke if the audit verifier reports that known manual-probe artifact.
- Payment reference numbers now continue monotonically across resets. Do not restore the
  old global `ALTER SEQUENCE ... RESTART` behavior.
- All service-internal reset calls must keep the signed caller tenant header; RLS cannot
  compensate for an explicitly wrong reseed tenant.

## Required loop

For every task: inspect → failing regression/adversarial test → minimal fix → narrow
test → full verification → update `PROJECT_STATE.md` and `docs/V8_TASK_LIST.md`.

```bash
npm run check
npm run test:all
# production-shaped config gate from docs/V8_EXECUTION_INSTRUCTION.md
npm run migrate
npm run dev
npm run smoke
# five invariant queries from docs/RUNBOOKS.md
node scripts/verify-audit-chain.mjs
```

Never weaken accounting, policy/compliance, payment-state, tenant-isolation, auth/RBAC,
provider/custody, or schema controls to make tests pass. Stop for Flo when `AGENTS.md`
requires human judgment.
