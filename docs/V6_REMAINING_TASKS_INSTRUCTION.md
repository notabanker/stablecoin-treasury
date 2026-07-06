# V6 Remaining Tasks — Execution Instruction

Use this as the exact implementation instruction for the next coding agent. It continues
`docs/V6_EXECUTION_INSTRUCTION.md` (the general operating manual — read it first; all of its
rules, workflow, commands, and report format still apply). This document supersedes its
"Current verified baseline" section and adds task-specific guidance for what remains.

```text
You are a Senior Staff Software Engineer and security-focused reliability engineer working in
a terminal environment on the Corporate Stablecoin Treasury Platform.

Your objective is to finish V6 by executing the remaining tasks from docs/V6_TASK_LIST.md,
one task per session, with the full build-verify-harden loop per task. General workflow,
rules, harness facts, and the session report format are in docs/V6_EXECUTION_INSTRUCTION.md
and are mandatory. Read, in order: PROJECT_STATE.md, this document, the task you are
executing in docs/V6_TASK_LIST.md, then the actual code files involved.

Current verified baseline (as of 2026-07-05, after Epic 3):
- 106 tests passing: 49 unit + 53 integration + 4 concurrency (npm run test:all).
- All approval gates A1–A6 are APPROVED (PROJECT_STATE.md § V6 Gate Status).
- Landed and loop-verified: Epic 0 (0.1–0.4 incl. csrf NOT NULL), Epic 4 (4.1 cookies,
  4.2 headers), Epic 6 (metrics, ops-watchdog, log-hygiene probe), Epic 1 (four-eyes
  approvals with signed acting-user context), Epic 3 (audit hash chain, verifier,
  nightly audit-chain-verify job, runbook).
- Migrations through 0032_audit_hash_chain.sql. Next free migration number: check
  `ls db/migrations | tail` (0033 at the time of writing).
- CI is proven green in GitHub Actions (badge in README; DB_POOL_MAX=2 there).
- The DB invariant check now has FIVE rows (all must be 0): negative_balances,
  ledger_imbalances, jobs_without_tenant, outbox_without_tenant, approval_rows_lt_count —
  plus `node scripts/verify-audit-chain.mjs` must exit 0. The full SQL is in
  docs/RUNBOOKS.md § DB Invariant Checks.
- Working tree contains all V6 work since commit ae42ebf, uncommitted. Never revert it;
  commit only when the human asks.

Remaining tasks, in execution order:
  1. Epic 2 — per-service Postgres roles + RLS (2.1 → 2.2 → 2.3). Gate A2 APPROVED.
  2. Epic 5 — provider adapter seam + statement ingestion (5.1 → 5.2). Gate A5 APPROVED.
     Task 5.3 (real sandbox rail) stays BLOCKED on business partner selection and a live
     secrets manager. Never start it; never place real credentials anywhere.
  3. Task 4.3 — ADR-011: OIDC in/out for pilot. Decision record only unless the human
     explicitly pulls SSO implementation into scope in the session prompt.
  4. Task 7.1 — in-repo deployment scaffolding (container hardening, CI image scan,
     per-environment env shapes, Terraform skeleton under infra/ with a "nothing here is
     provisioned" README).
  5. Task 7.2 — external infrastructure tracker table in docs/PRODUCTION_READINESS.md
     (owner + status per item, all "Not started"; agents track, humans execute).
  6. V6 close-out — write docs/V6_COMPLETION_REPORT.md mirroring the V5 report format
     (summary, files, per-epic fix evidence, test results, invariants, residual risks,
     go/no-go), reconcile docs/PRODUCTION_READINESS.md and docs/V6_TASK_LIST.md
     checkboxes, and propose V7 planning as the next step. Production money movement
     remains NO-GO at V6 close — Epic 7.2's external items are human-executed.

────────────────────────────────────────────────────────────────────────────────────────
EPIC 2 GUIDANCE (the highest-risk remaining epic — read before touching anything)

Order: migrate ONE schema at a time — policy → compliance → operations → reconciliation →
accounting → wallet → payment — with `npm run test:all` green after EVERY schema. Do 2.1
(roles) fully before 2.2 (RLS): RLS only binds when services connect as non-owner roles.

Roles (2.1):
- Postgres roles are CLUSTER-wide; grants are per-database. The test harness creates a
  throwaway database per stack, so: create roles in an idempotent DO block
  (IF NOT EXISTS on pg_roles), and put ALL grants in per-database migrations so every
  fresh test database gets them. Parallel test databases sharing cluster roles is fine.
- Derive the grant inventory from CODE, not from the architecture diagram. Grep
  query(/withTransaction( call sites per process, including pool-name aliases (the job
  worker uses `PB` = "payment") and shared modules that run inside other processes.
  Known cross-schema facts you must preserve (verify each anyway):
    - api-gateway process: identity.* (sessions, users, roles via auth.mjs) AND
      operations.audit_events INSERT + SELECT (emitSecurityAudit → audit.mjs; the chained
      insert SELECTs the chain head, so INSERT alone is NOT enough) AND platform webhook
      dedupe tables (webhooks.mjs).
    - job-worker process: platform.jobs, payment.* (saga + auto-expiry + idempotency
      sweep), operations.alerts INSERT/UPDATE (watchdog + chain alerts),
      operations.audit_events SELECT (audit-chain-verify).
    - relay-worker process: platform.outbox_events, platform.inbox_events.
    - every domain service: its own schema + platform.outbox_events INSERT (outbox emit)
      + platform.inbox_events (consumer dedupe via outbox.mjs).
- Per-service connections: stack.mjs currently injects ONE DATABASE_URL into all
  children; it must become role-scoped URLs per service. Update together: tests/helpers/
  stack.mjs, scripts/dev.mjs, docker-compose.yml, .github/workflows/ci.yml, .env.example,
  docs/ENVIRONMENT.md. Migrations keep running as the admin/owner user.
- Negative test: a service × foreign-schema access matrix (wallet role SELECTing
  payment.payments must fail, etc.).

RLS (2.2):
- ENABLE ROW LEVEL SECURITY + policy USING
  (tenant_id = current_setting('app.tenant_id', true)::uuid) on tenant-scoped tables,
  schema by schema. current_setting(..., true) returns NULL when unset → zero rows →
  fail closed. db.mjs sets `SET LOCAL app.tenant_id = ...` inside withTransaction and
  wraps bare queries in transactions where a tenant context exists.
- Workers legitimately cross tenants (relay poll, job claim, watchdog, chain verify):
  give svc_relay and svc_job BYPASSRLS, document it in the migration comment and
  docs/ENVIRONMENT.md. Domain services NEVER get BYPASSRLS.
- Interactions to test explicitly per schema BEFORE moving on (each has a live code path):
    - SELECT ... FOR UPDATE under RLS (payment approve/execute/cancel).
    - INSERT ... ON CONFLICT idempotency reservations (payment.idempotency_keys).
    - The deferred balanced-ledger trigger (wallet schema).
    - The audit chained insert's head lookup + pg_advisory_xact_lock (operations schema;
      advisory locks need no table privilege, but the head SELECT is tenant-filtered and
      must see rows — app.tenant_id must be set in the /audit and withInboxDedup paths
      AND in the gateway's emitSecurityAudit transaction).
    - Demo reset / reseed paths (they DELETE and re-INSERT across tenant rows).
- 2.3 adds the cross-tenant adversarial suite: WHERE-less SELECT as a domain role with
  tenant-1 context returns zero tenant-2 rows; idempotency-key collision across tenants;
  webhook-driven writes; repair endpoints; audit reads. Each probe must FAIL when its
  RLS policy is dropped in a scratch DB (prove the probe bites). Add the probes to
  docs/RELEASE_CHECKLIST.md and tick the Epic 8 items in docs/V6_TASK_LIST.md.

────────────────────────────────────────────────────────────────────────────────────────
EPIC 5 GUIDANCE

5.1 (adapter seam):
- The bar is ZERO behavior change: after refactoring saga step 3 behind
  CustodyAdapter { getBalances, submitTransfer, getTransferStatus } with
  SimulatedCustodyAdapter, the full suite must pass UNCHANGED (new adapter/breaker tests
  are additions, not modifications).
- Migration (next free number): operations.providers gains capabilities JSONB,
  environment TEXT CHECK (IN ('sandbox','prod')), adapter TEXT; seeds set
  environment='sandbox'. Unknown adapter key → provider unusable + alert-worthy, never a
  crash.
- Circuit breaker per provider instance (closed → open after N consecutive failures →
  half-open probe); expose breaker state via the extraMetrics pattern from Epic 6.1 and
  feed the existing policy provider-route check.
5.2 (statement ingestion):
- reconciliation.provider_statements (external_id UNIQUE per provider) +
  statement_lines; internal-auth-protected ingestion endpoint + file-drop script;
  matcher as a durable job (match by provider_ref, then amount+date+wallet with recorded
  confidence); mismatches open exceptions with reason categories missing_ours,
  missing_theirs, amount_mismatch, fee_mismatch, duplicate.
- SimulatedCustodyAdapter emits a statement line on settlement so settle → ingest →
  match runs end to end in tests with no partner.
- FK LESSON (cost this project a broken demo once already — see Lessons below): when you
  add tables that reference existing rows, update EVERY reset/seed delete path in the
  same change (reconciliation reseed must delete statement_lines before
  provider_statements before whatever they reference), then prove it with a
  POST /api/reset probe in an integration test AND the live smoke run.

────────────────────────────────────────────────────────────────────────────────────────
TASK 7.1 GUIDANCE
- Container hardening: read-only root filesystem, tmpfs for writable paths, dropped
  capabilities, tuned healthchecks (non-root already done). Compose stack must still
  boot and pass smoke.
- CI: add image build + vulnerability scan stage (trivy or equivalent), merge-blocking;
  keep total CI time reasonable (integration stage already dominates).
- Env shapes: .env.example.dev / .staging / .prod; CI validates the prod shape passes
  PRODUCTION_MODE=true npm run check.
- infra/ Terraform skeleton (modules: network, managed Postgres w/ PITR flag, secrets
  references, WAF-fronted ingress) — `terraform validate` must pass; no state, no
  credentials, README opens with "nothing here is provisioned". Never report
  infrastructure as done; that is Task 7.2's human-owned table.

────────────────────────────────────────────────────────────────────────────────────────
LESSONS FROM COMPLETED SESSIONS (hard-won; treat as rules)

1. NEVER skip the live smoke step. The Epic 1 session skipped it and shipped a demo-
   breaking FK regression (reset deleted payments before payment_approvals); Epic 3's
   loop caught it a session late. Smoke (`npm run smoke`) is non-negotiable in every loop.
2. Before `npm run dev`, check for a stale stack: a leftover gateway on 8080 makes your
   "fresh" verification hit OLD code (EADDRINUSE in your new stack's log is the tell).
   `lsof -ti :8080` then pkill the `node services/...` processes if needed.
3. Postgres INSERT ... SELECT does NOT infer bare $n parameter types from target columns
   (unlike VALUES) — cast every parameter explicitly ($1::text, $2::uuid, ...).
4. platform.inbox_events.event_id is an FK to platform.outbox_events — inbox-dedup code
   paths can only be exercised through REAL relayed events (e.g. create a payment and
   wait for the relayed audit event), not fabricated X-Event-Id headers.
5. New FK-referencing tables break reset/seed delete order silently. Update the seeds in
   the same change and probe /api/reset in tests.
6. Canonical serializations must live in exactly ONE place (the audit chain keeps its
   hash expression only in SQL — packages/shared/audit.mjs). Follow that principle for
   anything Epic 5 hashes or signs.
7. Update docs/V6_TASK_LIST.md checkboxes and PROJECT_STATE.md (session log at top) every
   session; the next agent starts from those two files.

────────────────────────────────────────────────────────────────────────────────────────
VERIFICATION LOOP (per task — deltas from the base instruction)
- Standard: npm run check → npm run test:all → prod-config gate → migrate + dev stack +
  /health + /ready + npm run smoke → invariants → UI check. Commands and the prod-gate
  env block are in docs/V6_EXECUTION_INSTRUCTION.md.
- Invariants now = the five-row SQL (docs/RUNBOOKS.md § DB Invariant Checks) plus
  `node scripts/verify-audit-chain.mjs` exit 0.
- After Epic 2 lands, add the role/RLS probes to the loop for all later tasks.
- Session report format: unchanged (Summary / Files Changed / Fix Evidence / Test
  Results / DB Invariants / Residual Risks / Gate Requests / Go-No-Go). Production money
  movement stays NO-GO for all of V6.
```
