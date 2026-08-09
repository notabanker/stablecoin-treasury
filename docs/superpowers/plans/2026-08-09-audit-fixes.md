# 2026-08 Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding from the 2026-08-09 whole-codebase audit (findings F0–F13 below) without weakening any existing control.

**Architecture:** Zero-dependency Node microservices over one Postgres (schema-per-service, RLS, audit hash chain). Every code fix is test-first (repo rule: no claim without a regression test); every behavior change is gated by Flo per AGENTS.md; doc fixes happen in the same task as the behavior they describe.

**Tech Stack:** Node ≥20 (ESM, `node:test`, only dep is `pg`), PostgreSQL 16, vanilla-JS frontend (no build), GitHub Actions CI.

## Global Constraints

- **No new dependencies.** Zero-dependency rule is a stated ADR — anything needing a package is a plan failure.
- **Money paths use `Money`** (packages/shared/money.mjs); never bare `Number()` on amount/fee/balance fields.
- **Migrations:** next free number is currently **0057**. Re-run `ls db/migrations | tail` immediately before creating any migration (session lesson: the 0049 collision).
- **Verification loop (per task):** narrow test → `npm run check` (known 0017 duplicate tolerated) → `npm run test:all` → for DB-touching tasks also: `npm run db:setup && npm run dev` + `npm run smoke` + 5 DB invariants (F7 scripts them; until then manual psql per docs/RUNBOOKS.md §DB Invariant Checks) + `node scripts/verify-audit-chain.mjs` (exit 0).
- **Docs claim only what's proven.** Any task that changes behavior must update its docs in the same task.
- **Approval gates (AGENTS.md):** tasks marked `Gate: Flo` must be explicitly approved (in-session prompt or PROJECT_STATE.md §V8 Gate Status) before implementation starts. The plan's recommended default is stated per task; Flo's decision overrides.
- **Do not loosen controls to make tests pass.** If a test is wrong, fix the test; if a control is wrong, get approval.
- **Commit after each task** with a conventional-commit message ending `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

| Area | Files touched |
|---|---|
| F0 (commit) | git working tree, no code |
| F1 (0055 guard) | `db/migrations/0057_guard_reset_seed.sql` (new), `tests/integration/reset-seed-guard.test.mjs` (new), `docs/RUNBOOKS.md` |
| F2 (expiry audit) | `services/job-worker/src/index.mjs`, `tests/integration/expiry-audit.test.mjs` (new) |
| F3 (read RBAC) | `db/migrations/0058_read_permissions.sql` (new, pending gate), `services/api-gateway/src/index.mjs`, `tests/integration/auth-rbac.test.mjs` (extend) |
| F4 (compliance truth) | `docs/PRODUCTION_READINESS.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md` |
| F5 (settlement webhook) | `services/job-worker/src/index.mjs`, `services/reconciliation-service/src/index.mjs` (pending gate), `tests/integration/webhooks.test.mjs` (extend) |
| F6 (HMAC raw bytes) | `services/api-gateway/src/webhooks.mjs`, `packages/shared/http.mjs`, `services/api-gateway/src/index.mjs`, `tests/integration/webhooks.test.mjs`, `docs/ENVIRONMENT.md` |
| F7 (invariants script) | `scripts/check-invariants.mjs` (new), `.github/workflows/ci.yml`, `docs/RUNBOOKS.md`, `package.json` |
| F8 (frontend tests) | `tests/unit/web-util.test.mjs` (new) |
| F9 (money rounding) | `packages/shared/money.mjs`, `tests/unit/money.test.mjs` |
| F10 (worker hygiene) | `services/job-worker/src/index.mjs` |
| F11 (dead code) | `services/payment-service/src/index.mjs`, `packages/shared/config.mjs`, `services/api-gateway/src/index.mjs`, `apps/web/js/views-wallets.js` (+ siblings per grep) |
| F12 (doc drift) | `docs/PRODUCTION_READINESS.md`, `docs/DATABASE.md`, `docs/V8_TASK_LIST.md`, `PROJECT_STATE.md` |
| F13 (0.1.4) | blocked on Flo's A/B/C decision; no files until chosen |

---

### Task F0: Commit the Q1–Q8 working tree

The entire Q5–Q8 remediation (~26 modified files, untracked `apps/web/js/`, `tests/unit/tenant.test.mjs`, `docs/QUALITY_REMEDIATION_INSTRUCTION.md`) is uncommitted; HEAD is 3 weeks stale. Every subsequent task's diff depends on a clean baseline.

**Files:** git working tree only.

- [ ] **Step 1: Verify the tree is green before committing**

```bash
npm run check && npm run test:all
```

Expected: `check` passes (known 0017 dup only); 170 tests pass (76 unit + 90 integration + 4 concurrency).

- [ ] **Step 2: Stage and inspect the staging summary**

```bash
git add apps/web packages/shared services tests docs/QUALITY_REMEDIATION_INSTRUCTION.md PROJECT_STATE.md docs/ENVIRONMENT.md
git status --short
```

Expected: no `node_modules`, no `.env*`, no `rag-system/` in the staged list.

- [ ] **Step 3: Commit with a message naming the remediation**

```bash
git commit -m "fix(Q1-Q8): quality remediation — tenant fail-closed, Money path, cookie-only sessions, main.js split

Q1 UUID createId · Q2 invalid tenant header 400 · Q3/Q6 Money path · Q4 log silent
failures · Q5 TENANT_HEADER_REQUIRED gate · Q7 cookie-only browser login · Q8 split
apps/web/main.js into js/{state,util,api,views-*}. Verified 170/170 (76 unit + 90
integration + 4 concurrency).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: Decide rag-system placement (ask Flo, do not commit it here)**

`rag-system/` is a standalone untracked experiment. Options: separate repo, or add to `.gitignore`. Ask Flo; do not fold it into the platform commit.

- [ ] **Step 5: Verify HEAD is the Q1–Q8 state**

```bash
git log --oneline -3 && git status --short
```

Expected: new commit on top of `a258a6f`; working tree clean except rag-system.

**Acceptance:** Q1–Q8 work is in git history; `npm run test:all` green at HEAD.

---

### Task F1: Guard the SECURITY DEFINER reset functions (audit finding #1, HIGH)

`db/migrations/0055` created seven `SECURITY DEFINER *.reset_seed(p_tenant_id)` functions that take a caller-supplied tenant UUID with no check against the session's `app.tenant_id`. Any role holding EXECUTE can delete another tenant's append-only rows (audit_events, payment_events, payment_approvals, ledger). Fix: migration 0057 wraps every function body in a tenant-context guard. **Gate: Flo** (DB migration + auth/RBAC-adjacent security policy).

**Files:**
- Create: `db/migrations/0057_guard_reset_seed.sql`
- Create: `tests/integration/reset-seed-guard.test.mjs`
- Modify: `docs/RUNBOOKS.md` (note the guard in the demo-reset section)

**Interfaces:**
- Consumes: existing `*.reset_seed(p_tenant_id uuid)` functions from 0055 (signatures unchanged — no caller changes needed).
- Produces: same seven functions, now failing with `reset_seed tenant mismatch` when the session `app.tenant_id` doesn't equal `p_tenant_id`, or when no tenant context is set (fail closed).

- [ ] **Step 1: Verify every `reset_seed` call site runs inside a tenant context**

```bash
grep -rn "reset_seed" services/*/src/seed.mjs services/*/src/index.mjs
```

Expected: each call is inside `runWithTenant(...)` (seed bootstrap and `/reset` handlers). If any call site lacks tenant context, it must be wrapped first — the guard makes uncontexted calls fail.

- [ ] **Step 2: Write the failing integration test**

`tests/integration/reset-seed-guard.test.mjs` — uses the direct-DB pattern from `tests/integration/auth-rbac.test.mjs` (short-lived per-query connections with role URLs from `stack._env`, per the 57P01 lesson in PROJECT_STATE.md):

```js
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack, stopStack } from "../helpers/stack.mjs";

const TENANT_1 = "00000000-0000-0000-0000-000000000001";
const TENANT_2 = "00000000-0000-0000-0000-000000000002";

// One connection per query — never a long-lived probe connection (57P01 lesson).
async function asRole(role, queryText, params) {
  const client = new pg.Client({ connectionString: role.url });
  await client.connect();
  try {
    return await client.query(queryText, params);
  } finally {
    await client.end();
  }
}

test("reset_seed refuses a tenant different from the session context", async (t) => {
  const stack = await startStack({ env: { ROLES: true } });
  t.after(() => stopStack(stack));
  const paymentRole = stack.roleUrls.svc_payment; // per-role DB URL, harness-provided
  await assert.rejects(
    asRole(paymentRole,
      `SET app.tenant_id = '${TENANT_1}'; SELECT payment.reset_seed('${TENANT_2}');`),
    /tenant mismatch/
  );
});

test("reset_seed refuses a call with no tenant context (fail closed)", async (t) => {
  const stack = await startStack({ env: { ROLES: true } });
  t.after(() => stopStack(stack));
  const paymentRole = stack.roleUrls.svc_payment;
  await assert.rejects(
    asRole(paymentRole, `SELECT payment.reset_seed('${TENANT_1}');`),
    /tenant mismatch/
  );
});

test("reset_seed succeeds when the session context matches", async (t) => {
  const stack = await startStack({ env: { ROLES: true } });
  t.after(() => stopStack(stack));
  const paymentRole = stack.roleUrls.svc_payment;
  const res = await asRole(paymentRole,
    `SET app.tenant_id = '${TENANT_1}'; SELECT payment.reset_seed('${TENANT_1}') AS ok;`);
  assert.equal(res.rows[0].ok, null); // void function, no error
});
```

Note: confirm `stack.roleUrls` is the actual harness export name when writing the test (`tests/helpers/stack.mjs`); if it differs, use the same accessor auth-rbac.test.mjs uses.

- [ ] **Step 3: Run it — must fail with the guard absent**

```bash
node --test tests/integration/reset-seed-guard.test.mjs
```

Expected: tests 1–2 FAIL (the function succeeds today), test 3 PASS.

- [ ] **Step 4: Create migration 0057**

First: `ls db/migrations | tail` (rule: re-check immediately before writing). Then create `db/migrations/0057_guard_reset_seed.sql` — replace all seven functions with the guarded form. One example (all seven follow the identical pattern):

```sql
-- Guard the SECURITY DEFINER reset functions (0055) against cross-tenant use.
--
-- 0055 took a caller-supplied p_tenant_id with no check against the session's
-- RLS tenant context (current_setting('app.tenant_id')), letting any role with
-- EXECUTE delete another tenant's append-only rows. Every function now fails
-- closed when the context is missing or differs.

CREATE OR REPLACE FUNCTION payment.reset_seed(p_tenant_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reset_seed tenant mismatch: context % vs target %',
      NULLIF(current_setting('app.tenant_id', true), ''), p_tenant_id;
  END IF;
  DELETE FROM payment.idempotency_keys WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_events WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payment_approvals WHERE tenant_id = p_tenant_id;
  DELETE FROM payment.payments WHERE tenant_id = p_tenant_id;
END;
$$;

-- Repeat for wallet, operations, accounting, policy, compliance, reconciliation
-- reset_seed — same guard, same body as 0055. GRANT EXECUTE lines are unchanged
-- (CREATE OR REPLACE keeps existing grants, so do NOT re-run them).
```

- [ ] **Step 5: Run the test — must pass**

```bash
node --test tests/integration/reset-seed-guard.test.mjs
```

Expected: 3/3 PASS. Then full suite: `npm run check && npm run test:all`.

- [ ] **Step 6: Verify the whole loop (migration is DB-touching)**

```bash
npm run db:setup && npm run dev   # boot the stack; services reseed tenant-1 at boot
npm run smoke                     # reset path still works under tenant context
```

Then the 5 DB invariants (manual psql, docs/RUNBOOKS.md §DB Invariant Checks) and `node scripts/verify-audit-chain.mjs` — both must be clean/exit 0. Boot failure (42501 at seed) means a call site lost its tenant context — fix the call site, never the guard.

- [ ] **Step 7: Update `docs/RUNBOOKS.md`** — in the demo-reset section, one sentence: reset functions are tenant-context-guarded since 0057; uncontexted calls raise `reset_seed tenant mismatch`.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/0057_guard_reset_seed.sql tests/integration/reset-seed-guard.test.mjs docs/RUNBOOKS.md
git commit -m "fix(security): guard SECURITY DEFINER reset_seed by RLS tenant context

Closes audit finding #1: 0055 took caller-supplied tenant UUID with no context
check, letting any service role wipe another tenant's append-only rows. 0057
fails closed when app.tenant_id is missing or differs. 3 regression tests.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

**Acceptance:** cross-tenant and uncontexted `reset_seed` calls raise; matched-context reseed works end-to-end (smoke green); boot reseed works.

---

### Task F2: Payment auto-expiry must write to the audit trail (audit finding #5, HIGH)

`payment-auto-expiry` in job-worker does a raw `UPDATE ... SET status='Cancelled'` with no audit/outbox event — the one state transition invisible to the hash chain. Every other transition emits an outbox `audit.event_recorded` event (pattern at `services/payment-service/src/index.mjs:353-374`), consumed by operations-service `/audit`. **Gate: Flo** (payment state-machine semantics).

**Files:**
- Modify: `services/job-worker/src/index.mjs` (the `payment-auto-expiry` handler, ~line 98)
- Create: `tests/integration/expiry-audit.test.mjs`

**Interfaces:**
- Consumes: `appendOutboxEvents(client, events)` and `withTenant(events, tenantId)` from `packages/shared/outbox.mjs`; `withTransaction` from `packages/shared/db.mjs` (verify these are already imported in job-worker; add missing imports).
- Produces: one `audit.event_recorded` outbox event per expired payment, `{ actor: "System", action: "Payment expired", object: <reference>, detail: "Auto-cancelled after 72h" }`.

- [ ] **Step 1: Write the failing test**

New `tests/integration/expiry-audit.test.mjs`. Create a payment via the gateway (seed policy auto-approves a small amount — reuse the create-payment helper pattern from `tests/integration/payment-lifecycle.test.mjs`), then:

```js
// age the payment beyond the 72h expiry window (test-only UPDATE)
await stack.dbQuery("payment",
  `UPDATE payment.payments SET created_at = now() - interval '73 hours' WHERE id = $1`,
  [paymentId]);
// enqueue the expiry job directly and poll for its effect (the scheduler runs
// hourly; a deterministic run needs a direct enqueue into platform.jobs)
await stack.dbQuery("platform",
  `INSERT INTO platform.jobs (id, type, payload, tenant_id, max_attempts, status, attempts)
   VALUES ($1, 'payment-auto-expiry', '{}', $2, 1, 'pending', 0)`,
  [crypto.randomUUID(), tenantId]);
// poll up to the stack ready timeout: payment status Cancelled + audit row present
const audit = await stack.dbQuery("operations",
  `SELECT action FROM operations.audit_events
   WHERE tenant_id = $1 AND action = 'Payment expired' LIMIT 1`,
  [tenantId]);
assert.ok(audit.rows[0], "expired payment must produce an audit event");
```

(Poll with the same eventually-pattern the saga tests use; consult `tests/helpers/stack.mjs` for the exact dbQuery helper name.)

- [ ] **Step 2: Run it — must fail** (no audit row today): `node --test tests/integration/expiry-audit.test.mjs`

- [ ] **Step 3: Implement — wrap the UPDATE in a transaction that also appends outbox events**

Replace the handler body (current code at `services/job-worker/src/index.mjs:98-126`):

```js
registerHandler("payment-auto-expiry", async () => {
  const tenantIds = await getActiveTenants();
  let totalExpired = 0;
  const allExpiredIds = [];
  for (const tenantId of tenantIds) {
    const { rows } = await withTransaction("payment", async (client) => {
      const res = await client.query(
        `UPDATE payment.payments
         SET status = 'Cancelled'
         WHERE status = 'Pending approval'
           AND tenant_id = $1
           AND created_at < now() - INTERVAL '72 hours'
         RETURNING id, reference`,
        [tenantId]
      );
      if (res.rows.length > 0) {
        await appendOutboxEvents(client, withTenant(
          res.rows.map((r) => ({
            aggregateType: "payment",
            aggregateId: r.id,
            eventType: "audit.event_recorded",
            payload: { actor: "System", action: "Payment expired", object: r.reference, detail: "Auto-cancelled after 72h" }
          })),
          tenantId
        ));
      }
      return res.rows;
    });
    if (rows.length > 0) {
      totalExpired += rows.length;
      allExpiredIds.push(...rows.map((r) => r.id));
    }
  }
  if (totalExpired > 0) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: "auto_expiry",
      expired: totalExpired,
      paymentIds: allExpiredIds
    }));
  }
});
```

- [ ] **Step 4: Run test — must pass**, then `npm run check && npm run test:all`.
- [ ] **Step 5: Verify loop** — `npm run dev` + `npm run smoke` + `node scripts/verify-audit-chain.mjs` (the new audit rows are chained — a broken chain here would fail the verifier).
- [ ] **Step 6: Commit**

```bash
git commit -am "fix(worker): payment auto-expiry now emits chained audit events

Closes audit finding #5 — expiry was the only transition invisible to the audit
hash chain. Mirrors the cancel-path pattern (outbox audit.event_recorded).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

**Acceptance:** expired payments produce `action='Payment expired'` chained audit rows; expiry still works; chain verifier clean.

---

### Task F3: Permission-check the read endpoints (audit finding #6, HIGH)

`GET /api/payments/:id/approvals` (gateway index.mjs:86), `GET /api/payments/:id/attempts` (:83), and `GET /api/repair` (:149) are `guard()`-only (any authenticated user). **Gate: Flo** — the role matrix is an RBAC policy decision. Recommended default (stated for approval): introduce `payment:read` granted to all four tenant roles (analyst, approver, treasury-manager, admin) — formalizes current effective access, makes it auditable, and future roles can be denied by omission; `repair` additionally requires `payment:execute`-level roles (treasury-manager + admin) since the repair list is operational.

**Files:**
- Create: `db/migrations/0058_read_permissions.sql` (only if new permission strings are needed — check existing seeds first: `grep -rn "payment:read" db/migrations/`)
- Modify: `services/api-gateway/src/index.mjs` (three routes)
- Modify: `tests/integration/auth-rbac.test.mjs`

- [ ] **Step 1 (gate):** Get Flo's approval of the matrix (in-session or PROJECT_STATE.md) before any code. If the existing permission set already covers reads, no migration is needed — re-use it.
- [ ] **Step 2: Write failing tests** in `tests/integration/auth-rbac.test.mjs`: log in as analyst (has `payment:read`, lacks `payment:execute`) → approvals/attempts 200, repair 403; log in as treasury-manager → all three 200. (Follow the existing login/session helpers in that file.)
- [ ] **Step 3: Run — must fail** (all roles currently 200 on repair).
- [ ] **Step 4: Implement** — wrap the three routes:

```js
route("GET", "/api/payments/:id/attempts", paymentPerm("read")(guard(async (ctx) => {
  return ok({ attempts: await serviceGet("payment", `/payments/${ctx.params.id}/attempts`, tenantOptions(ctx)) });
})));
route("GET", "/api/payments/:id/approvals", paymentPerm("read")(guard(async (ctx) => {
  return ok(await serviceGet("payment", `/payments/${ctx.params.id}/approvals`, tenantOptions(ctx)));
})));
route("GET", "/api/repair", paymentPerm("execute")(guard(async (ctx) => {
  return ok(await serviceGet("payment", "/repair", tenantOptions(ctx)));
})));
```

- [ ] **Step 5: Tests pass; `npm run check && npm run test:all`.**
- [ ] **Step 6: Commit.**

**Acceptance:** read access matches the approved matrix; existing users' effective access unchanged for the default proposal.

---

### Task F4: Stop overclaiming compliance screening (audit finding #3, HIGH)

`compliance-service /screen` returns the seeded status verbatim (stub). Docs claim real screening. Fix is doc-truth only — implementing screening is a product decision (ask Flo; not in this plan).

**Files:** `docs/PRODUCTION_READINESS.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`.

- [ ] **Step 1: Find every screening claim**

```bash
grep -rni "screen\|Sentinel" docs/PRODUCTION_READINESS.md docs/ARCHITECTURE.md docs/ENVIRONMENT.md README.md
```

- [ ] **Step 2: Rewrite claims to match code** — replace screening capability claims with: "counterparty screening is simulated: `/screen` returns the counterparty's seeded screening status; no external screening provider is connected." Delete the "Sentinel Chain Analytics" references or mark them as planned (V8 roadmap) only.
- [ ] **Step 3: Add the same one-line truth to `docs/ENVIRONMENT.md`** under compliance-service.
- [ ] **Step 4: Commit** (`docs: compliance /screen is simulated — align readiness claims with code`).

**Acceptance:** no doc asserts real screening; a new agent reading docs can't be misled.

---

### Task F5: Wire settlement webhooks to reconciliation (audit finding #4, HIGH)

`process-settlement-webhook` (job-worker index.mjs:146-163) only marks the webhook processed — the "Future: trigger reconciliation match" comment is a dead end. **Gate: Flo** (payment/reconciliation semantics + provider assumptions). Recommended design: on `transfer.settled`/`settlement_confirmed`, find the provider's statement lines whose `provider_ref` matches the webhook's paymentRef and run the existing matcher (`POST /statements/:id/match`) for that statement.

**Files:**
- Modify: `services/job-worker/src/index.mjs`
- Modify: `services/reconciliation-service/src/index.mjs` (only if a lookup endpoint is needed — check `GET /statements` query params first)
- Modify: `tests/integration/webhooks.test.mjs`

- [ ] **Step 1 (gate):** Flo approves the behavior (match statements containing the settled provider_ref).
- [ ] **Step 2 (design check):** Read `docs/V3_DEMO_SCENARIOS.md` + `docs/V6_TASK_LIST.md` Epic 5.2 to confirm intended semantics; record the decision in the task notes.
- [ ] **Step 3: Write failing test** in `tests/integration/webhooks.test.mjs`: ingest a statement with an unmatched line for provider_ref X, deliver `transfer.settled` webhook for X, poll until `reconciliation.reconciliation_rows` gains a Matched row.
- [ ] **Step 4: Implement** — in the job handler, after marking the event processed: query `reconciliation.provider_statements` joined to `statement_lines` for the provider + ref (job-worker is BYPASSRLS; scope by `tenant_id`), then `servicePost("reconciliation", "/statements/:id/match", {}, { tenantId })` per statement. Reuse the match orchestration pattern from the `match-statement` job.
- [ ] **Step 5: Test passes; `npm run check && npm run test:all`; commit.**

**Acceptance:** a settled webhook triggers statement matching for the referenced payment; duplicate webhooks stay deduped (existing webhook_events unique insert unchanged).

---

### Task F6: Sign webhooks over raw bytes (audit finding #7, MEDIUM)

`verifySignature` (webhooks.mjs:12-19) HMACs `JSON.stringify(parsedBody)` — key-order-dependent, breaks interop with real providers that sign raw request bytes. **Gate: Flo** (provider contract change; the demo-signature path and webhook tests change together).

**Files:**
- Modify: `packages/shared/http.mjs` (expose raw body to route handlers), `services/api-gateway/src/webhooks.mjs`, `services/api-gateway/src/index.mjs`, `tests/integration/webhooks.test.mjs`, `docs/ENVIRONMENT.md`

- [ ] **Step 1 (gate):** Flo approves the signature-contract change.
- [ ] **Step 2: Write failing test** — update `tests/integration/webhooks.test.mjs` to sign the raw body bytes:

```js
const raw = JSON.stringify(payload);
const signature = createHmac("sha256", secret).update(raw).digest("hex");
// send with Content-Type: application/json; a receiver that re-serializes must fail
```

- [ ] **Step 3: Run — must fail** against today's JSON.stringify-based verify.
- [ ] **Step 4: Implement** — `readBody` in `packages/shared/http.mjs` (currently parses to JSON at line ~306) returns `{ body, rawBody }` to the route context; the webhook route passes `rawBody` to `processWebhook`; `verifySignature(rawBody, secret, signature)` signs `Buffer.from(rawBody)` with no re-serialization:

```js
export function verifySignature(rawBody, secret, signature) {
  const expected = createHmac("sha256", secret).update(String(rawBody)).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(String(signature || ""), "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}
```

All other `readBody` consumers keep using `body` only — no behavior change outside webhooks.

- [ ] **Step 5: Tests pass; `npm run check && npm run test:all`; update `docs/ENVIRONMENT.md` webhook-signing section (signature is over the raw request body); commit.**

**Acceptance:** signature valid only over exact raw bytes; all non-webhook routes unchanged.

---

### Task F7: Script the DB invariants and wire them into CI (audit finding #8, MEDIUM)

The 5 DB invariant queries + audit-chain verifier exist only in docs/RUNBOOKS.md and run manually. Script them so CI enforces them.

**Files:**
- Create: `scripts/check-invariants.mjs`
- Modify: `.github/workflows/ci.yml`, `package.json` (`"invariants"` script), `docs/RUNBOOKS.md`

- [ ] **Step 1: Write the script** — modeled on `scripts/check-syntax.mjs` (exit 0/1), using `pg` from `DATABASE_URL` (default `postgres://127.0.0.1:5432/treasury_dev`), running the five queries from docs/RUNBOOKS.md §DB Invariant Checks verbatim:

```js
// scripts/check-invariants.mjs
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgres://127.0.0.1:5432/treasury_dev" });
await client.connect();
const checks = [
  ["negative balances", `SELECT count(*)::int AS n FROM wallet.wallet_balances WHERE balance < 0`],
  ["unbalanced ledger transactions", `
    SELECT count(*)::int AS n FROM (
      SELECT lt.id FROM wallet.ledger_transactions lt
      JOIN wallet.ledger_entries le ON le.transaction_id = lt.id
      GROUP BY lt.id
      HAVING SUM(CASE WHEN le.direction='debit' THEN le.amount ELSE -le.amount END) <> 0
    ) t`],
  ["NULL-tenant jobs", `SELECT count(*)::int AS n FROM platform.jobs WHERE tenant_id IS NULL`],
  ["NULL-tenant outbox events", `SELECT count(*)::int AS n FROM platform.outbox_events WHERE tenant_id IS NULL`],
  ["approvals integrity", `
    SELECT count(*)::int AS n FROM payment.payments p
    WHERE p.approvals > (SELECT COUNT(DISTINCT approver_id)
                         FROM payment.payment_approvals a WHERE a.payment_id = p.id)`]
];
let failed = false;
for (const [name, sql] of checks) {
  const { rows } = await client.query(sql);
  if (rows[0].n !== 0) { failed = true; console.error(`INVARIANT VIOLATION: ${name} (${rows[0].n})`); }
  else { console.log(`ok: ${name}`); }
}
await client.end();
if (failed) process.exit(1);
console.log("all DB invariants clean");
```

- [ ] **Step 2: Run against a live dev stack** — `npm run dev`, then `node scripts/check-invariants.mjs`; expect 5× `ok`. (Smoke reset leaves the DB in a clean demo state — run after smoke.)
- [ ] **Step 3: Add to `package.json`** — `"invariants": "node scripts/check-invariants.mjs"`.
- [ ] **Step 4: Wire into CI** — add to the `test` job after the test steps:

```yaml
      - run: npm run invariants
        env:
          DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/postgres
```

- [ ] **Step 5: Update `docs/RUNBOOKS.md`** — the invariant section now says `npm run invariants` replaces the manual psql block (keep the SQL as reference).
- [ ] **Step 6: Commit.**

**Acceptance:** `npm run invariants` exits 0 on a clean stack, 1 on any violation; CI runs it.

---

### Task F8: Unit tests for the frontend pure logic (audit finding #9, MEDIUM)

`apps/web/js/` has zero tests (syntax-only). `state.js` touches `document` at module scope (verified: lines 1–2), so tests stub the DOM before import. Target the pure functions: `computeMetrics`, `filteredPayments` (util.js).

**Files:**
- Create: `tests/unit/web-util.test.mjs`

- [ ] **Step 1: Write the test**

```js
import test from "node:test";
import assert from "node:assert/strict";

// state.js reads document at module scope — stub the bare minimum before import.
globalThis.document = { querySelector: () => ({ innerHTML: "", addEventListener: () => {} }) };

const { computeMetrics, filteredPayments } = await import("../../apps/web/js/util.js");
const { state } = await import("../../apps/web/js/state.js");

test("computeMetrics aggregates the dashboard cards", () => {
  const data = {
    wallets: [
      { asset: "EURC", valueEur: 100 },
      { asset: "BTC", valueEur: 300 }
    ],
    payments: [{ status: "Blocked" }, { status: "Pending approval" }],
    providers: [{ status: "Operational" }, { status: "Degraded" }],
    reconciliation: [{ status: "Open" }],
    journalEntries: [{ status: "Ready" }, { status: "Exported" }]
  };
  const m = computeMetrics(data);
  assert.equal(m.blockedPayments, 1);
  assert.equal(m.pendingApprovals, 1);
  assert.equal(m.degradedProviders, 1);
  assert.equal(m.openExceptions, 1);
  assert.equal(m.readyJournals, 1);
  assert.equal(m.eurAssetShare, 0.25); // 100 / (100+300)
  assert.equal(m.totalEur, 400);
});

test("filteredPayments filters by status and search text", () => {
  state.data = {
    payments: [
      { id: "p1", reference: "PAY-1001", type: "Supplier", asset: "EURC", memo: "invoices", status: "Pending approval", counterpartyId: "c1" },
      { id: "p2", reference: "PAY-1002", type: "Intra-group", asset: "EURC", memo: "transfer", status: "Settled", counterpartyId: "c2" }
    ],
    counterparties: [{ id: "c1", name: "ACME GmbH" }, { id: "c2", name: "Nordic AB" }]
  };
  state.filters.paymentStatus = "All";
  state.filters.paymentSearch = "ACME";
  assert.equal(filteredPayments().length, 1);
  assert.equal(filteredPayments()[0].id, "p1");
  state.filters.paymentSearch = "";
  state.filters.paymentStatus = "Settled";
  assert.equal(filteredPayments().length, 1);
  assert.equal(filteredPayments()[0].id, "p2");
});
```

Note: if `util.js` imports additional DOM-bound modules beyond `state.js` at module scope, extend the stub (one line per `document`/`window` accessor) — the stub approach is proven by the module-scope check; do not refactor the app for the tests.

- [ ] **Step 2: Run — must pass** (`node --test tests/unit/web-util.test.mjs`), then `npm run test` (file joins the unit glob) and `npm run check`.
- [ ] **Step 3: Commit.**

**Acceptance:** pure frontend logic covered; unit suite grows by 2; app code untouched.

---

### Task F9: Fix `Money.fromString` truncation (audit finding #10, MEDIUM)

`money.mjs:35` truncates the 3rd decimal (`"1.005"` → `1.00`) while the header claims rounding at construction; `times`/`divide` also round-trip through `Number` (precision loss beyond 2^53 cents — documented ceiling, not fixing unless asked). **Gate: Flo** — money semantics are accounting-adjacent. Recommended: truncation → half-up rounding, matching `fromNumber`.

**Files:**
- Modify: `packages/shared/money.mjs` (the `fromString` branch at ~line 35)
- Modify: `tests/unit/money.test.mjs`

- [ ] **Step 1 (gate):** Flo approves half-up rounding of the 3rd decimal (or states a preference).
- [ ] **Step 2: Write failing tests** in `tests/unit/money.test.mjs`:

```js
test("fromString rounds half-up at the 3rd decimal", () => {
  assert.equal(Money.fromString("1.005").toNumber(), 1.01);
  assert.equal(Money.fromString("1.004").toNumber(), 1.0);
});
```

- [ ] **Step 3: Run — must fail** (current behavior: 1.00, 1.00).
- [ ] **Step 4: Implement** — replace the truncating slice with a cent-rounded conversion consistent with `fromNumber` (e.g. parse the exact decimal string, round the 3rd digit half-up, or delegate: `Money.fromNumber(Number(cleaned))` — but keep the exact-string path for pg numeric strings that overflow `Number`; fix the `slice` branch only).
- [ ] **Step 5: Tests pass; `npm run check && npm run test:all`; update the header comment to state the exact behavior; commit.**

**Acceptance:** 3rd-decimal behavior matches the documented contract; all existing money tests still pass (any test relying on truncation is updated in this task, with the change called out in the commit message).

---

### Task F10: Job-worker hygiene (audit findings #14/#15, MEDIUM/LOW)

Three small fixes, one task.

**Files:** `services/job-worker/src/index.mjs`.

- [ ] **Step 1: Unknown job types must fail loudly, not silently complete**

Current dispatch (index.mjs:603-613) warns and `completeJob`s. Change to fail the job so it dead-letters and raises the existing DLQ alert:

```js
if (!handler) {
  metrics.noHandler++;
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    event: "job_no_handler",
    jobId: job.id,
    type: job.type
  }));
  await failJob(job.id, `Unknown job type: ${job.type}`, { maxAttempts: job.max_attempts });
  continue;
}
```

(Keep `metrics.noHandler++`; it's the alert signal.)

- [ ] **Step 2: Fix the deadLettered over-count** — dispatch increments `metrics.deadLettered++` when `job.attempts + 1 >= job.max_attempts`, but `failJob` dead-letters when `job.attempts >= maxAttempts` (attempts was already incremented at claim). Mirror failJob's condition:

```js
} catch (error) {
  metrics.failed++;
  if (job.attempts >= job.max_attempts) metrics.deadLettered++;
  ...
```

- [ ] **Step 3: Fix the watchdog alert detail** — the insert hardcodes `Outbox lag: ${check.count}ms.` for every check type (index.mjs:310). Replace with a truthful, generic message:

```js
`${check.type}: ${check.count} > ${check.threshold}`
```

- [ ] **Step 4: Verify** — `npm run check && npm run test:all` (saga + outbox-dlq tests exercise the dispatch path), plus a manual probe: enqueue a job with a bogus type via psql and confirm it dead-letters after `maxAttempts` and an alert appears in `operations.alerts`.
- [ ] **Step 5: Commit** (`fix(worker): unknown job types dead-letter; accurate deadLettered count and watchdog detail`).

**Acceptance:** bogus job types dead-letter with alert; metrics match failJob semantics; watchdog detail no longer claims ms for non-lag checks.

---

### Task F11: Remove dead code (audit finding #14, MEDIUM)

All verified-unused, surgical deletions — no refactors.

**Files:**
- `services/payment-service/src/index.mjs` — `findOpenExecutionJobInTx` (line ~507, zero callers)
- `packages/shared/config.mjs` — `SENSITIVE_KEYS` (lines 14-17, zero references)
- `services/api-gateway/src/index.mjs` — `activeView: "dashboard"` field (client never reads it; grep `activeView` in `apps/web/js/` first — if read, keep and skip)
- `apps/web/js/views-wallets.js` (+ siblings) — unused imports at module top (verified list in the audit: `views, appEl, detail, emptyState, option, pill, shortTenant, computeMetrics, filteredPayments, createIdempotencyKey, post, loadPaymentApprovals, renderToast`; re-grep each before deleting — the audit is a snapshot)

- [ ] **Step 1: Re-verify each target is unused** — `grep -rn "findOpenExecutionJobInTx\|SENSITIVE_KEYS\|activeView" services packages apps` — only the definitions remain.
- [ ] **Step 2: Delete** — remove the four items above (each is an isolated deletion; do not touch neighboring code).
- [ ] **Step 3: Verify** — `npm run check && npm run test:all` (frontend files are syntax-checked only, so also open the app once: `npm run dev` + load `http://localhost:8080` and check the console for `activeView` errors).
- [ ] **Step 4: Commit** (`refactor: remove dead code found in 2026-08 audit — no behavior change`).

**Acceptance:** zero behavior change (suite identical at 170); greps come up empty.

---

### Task F12: Fix doc drift (audit finding #13, LOW)

**Files:**
- `docs/PRODUCTION_READINESS.md` — test counts say 151; update to the current verified number (170 as of 2026-08-05; re-verify with `npm run test:all` before writing).
- `docs/DATABASE.md` — "only one tenant is seeded" → two tenants (Vega + Nordic) since 0021/0054.
- `docs/V8_TASK_LIST.md` — tick 0.4.3 (session token out of login JSON — closed by Q7) and 0.4.10 (approvals UI — closed by a258a6f) with a "(closed by Q7 / a258a6f)" note.
- `PROJECT_STATE.md` — "Active References" is current; do NOT edit the root CLAUDE.md (Prime Lab managed) — if the V6-pointer drift matters, note it in PROJECT_STATE.md instead.

- [ ] **Step 1: Re-verify the claims before writing** — run `npm run test:all`; confirm the count; confirm both tenants in `identity.tenants`.
- [ ] **Step 2: Apply the four doc edits.**
- [ ] **Step 3: Commit** (`docs: fix drift — test counts, tenant seeding, V8 checklist items`).

**Acceptance:** no doc contradicts the current tree.

---

### Task F13: Unblock 0.1.4 (external dependency)

Blocked on Flo's A/B/C decision (PROJECT_STATE.md, 2026-07-12 session log): how to boot a `PRODUCTION_MODE=true` gateway against a non-localhost test DB. Not implementable until chosen — do not improvise.

- [ ] **Step 1:** Get Flo's decision (A: Dockerized Postgres test DB / B: narrow test-only exception in `validateProductionConfig` / C: sub-HTTP wiring test).
- [ ] **Step 2:** Implement the chosen option per `docs/V8_TASK_LIST.md` 0.1.4 acceptance criteria, with the adversarial HTTP test asserting `403 demo_reset_disabled` under `PRODUCTION_MODE=true` without `ALLOW_DEMO_RESET`.
- [ ] **Step 3:** Tick 0.1.4 in `docs/V8_TASK_LIST.md`; update PROJECT_STATE.md.

**Acceptance:** 0.1.4 passes under the chosen infrastructure; audit item M7 (last open item from AUDIT_V4) closes.

---

## Self-Review

**Spec coverage** — audit findings mapped: #1→F1, #2→F0, #3→F4, #4→F5, #5→F2, #6→F3, #7→F6, #8→F7, #9→F8, #10→F9, #11→F10, #12→F11, #13→F12, #14→F10+F11, #15→F10, M7/0.1.4→F13. The LOW cosmetic items from the audit (cookie-flag mislabel, `payment.type` free string, client timeout race, `reseedPolicy` non-transactional, watchdog hardcode) are not in the plan — they are either covered (watchdog hardcode → F10), already documented/accepted (rate limiter → ADR-010), or product decisions deferred to Flo (payment.type validation, timeout race) — flagged in the audit report, deliberately not plan tasks.

**Placeholder scan** — every code step carries real code. Two steps are intentionally conditional: F3 Step 1 (gate — matrix may need no migration; the route change itself is unconditional) and F13 (blocked on an explicit human decision — restating the three options IS the content). F5 includes a design-check step (Step 2) because the exact match semantics must be confirmed against V3 docs before implementation; the implementation path is specified.

**Type consistency** — `reset_seed` signature unchanged (F1); `appendOutboxEvents(client, events)` + `withTenant(events, tenantId)` used in F2 exactly as in payment-service; `verifySignature(rawBody, ...)` in F6 matches the updated route wiring; `failJob(jobId, msg, { maxAttempts })` in F10 matches jobs.mjs's actual signature; `paymentPerm("read"|"execute")` in F3 matches the existing helper at gateway index.mjs:20.
