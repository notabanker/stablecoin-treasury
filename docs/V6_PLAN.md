# V6 Plan — From Hardened Demo to Operable Pilot

Drafted: 2026-07-04. Source inputs: `docs/PRODUCTION_MVP_BACKLOG.md` (master backlog), `docs/V5_COMPLETION_REPORT.md` (incl. V5.1 addendum), verification of the current code state at planning time.

## Where V5 Left Us

Verified true at planning time (all backed by tests or direct inspection):

- 95 tests passing (49 unit + 42 integration + 4 concurrency); smoke + DB invariants clean.
- Application-layer security enforced and regression-tested: auth, RBAC, cookie sessions with
  strict CSRF (including logout and null-token sessions), login brute-force lockout,
  tenant-scoped security audit, internal service HMAC auth, webhook signature validation,
  proxy-aware rate limiting, production boot gate.
- Money core delivered: append-only double-entry ledger, DB-enforced payment state machine,
  transactional outbox/inbox, durable jobs, async execution saga, repair endpoints.

Verified **gaps** at planning time (each checked against the code, not assumed):

| # | Gap | Evidence |
|---|---|---|
| G1 | Approvals are an anonymous counter — no approver identity, no `payment_approvals` table, no creator-cannot-approve, one user can supply both approvals | `services/payment-service/src/index.mjs` `approvePayment()`; no approvals table in `db/migrations/` |
| G2 | No per-service Postgres roles, no RLS — every service role can read every schema | no `CREATE ROLE`/`CREATE POLICY`/RLS in `db/migrations/` |
| G3 | Audit rows are append-only (REVOKE) but not tamper-evident — no hash chain | no `prev_hash` anywhere |
| G4 | `identity.sessions.csrf_token` nullable at schema level (runtime-strict only) | `db/migrations/0028_session_csrf.sql`; documented in `docs/ENVIRONMENT.md` |
| G5 | Rate limiting and login lockout are in-memory per process — reset on restart, not shared across replicas | `packages/shared/http.mjs`, `packages/shared/auth.mjs` |
| G6 | No OIDC/SSO — local email+password only | no OIDC code in `services/` or `packages/` |
| G7 | Provider execution is simulated — no adapter interface, no sandbox/prod separation, no real custody/screening rail | `services/payment-service` saga step 3 |
| G8 | No reconciliation statement ingestion — recon rows derive from our own payment events, not provider statements | `services/reconciliation-service` |
| G9 | Observability is per-service `/metrics` counters only — no money-path metrics (outbox lag, DLQ size, stuck payments), no alert rules, no trace propagation beyond request-id | `packages/shared/http.mjs` `createMetrics` |
| G10 | No IaC, secrets manager, WAF, managed Postgres/PITR, mTLS — the entire infrastructure phase | repo has compose + CI yml only |
| G11 | `docs/PRODUCTION_READINESS.md` predates M2–M5 and understates the delivered state (stale in the conservative direction) | doc still lists ledger/saga/RBAC as "still required" |
| G12 | CI workflow never proven in GitHub Actions | `.github/workflows/ci.yml` untested remotely |

## V6 Objective

Make the platform **pilot-operable**: real governance controls (four-eyes with identity),
database-level defense in depth, tamper-evident audit, operational visibility with alerting,
and a provider adapter seam ready for the first sandbox rail — while keeping the strict
build-verify-harden loop and never claiming infrastructure work that hasn't happened.

Explicitly **not** in V6: issuing tokens, becoming a CASP, real production credentials before a
secrets manager exists (backlog rule 5.1.2), multi-region, mobile.

## Human Approval Gates (decide before the epic starts)

`PROJECT_STATE.md` requires human approval for schema, payment-semantics, and auth-policy
changes. This plan is the request. Each item defaults to **blocked** until approved:

- **A1 (Epic 1):** New `payment.payment_approvals` table + approval semantics change
  (approver identity required, creator-cannot-approve, distinct approvers). Changes the meaning
  of the existing approvals counter.
- **A2 (Epic 2):** Per-service Postgres roles + RLS policies on all tenant-scoped tables.
  Schema-wide migration; changes local dev setup (role creation).
- **A3 (Epic 3):** `operations.audit_events` gains `prev_hash`/`row_hash` columns (additive).
- **A4 (Epic 0):** Backfill + `NOT NULL` on `identity.sessions.csrf_token` (carried from V5.1).
- **A5 (Epic 5):** Adapter interface shape and `providers` table changes (capabilities,
  environment column).
- **A6 (Epic 7):** Cloud/infra ADRs — secrets manager choice, IaC tool, runtime target
  (backlog ADR-008/009). Business input needed; agent can only scaffold.

## Epic 0 — Truth Reconciliation and Carried Debt

Priority: P0 · Complexity: S · Blocked on: A4 only (task 0.2)

The cheapest epic and the one that keeps every later claim honest.

### Task 0.1 — Rewrite `docs/PRODUCTION_READINESS.md` to match reality (G11)
- Restate what is delivered (M0–M5 scope) with pointers to the tests that prove each claim.
- Restate what is not (G1–G10), each with its V6 epic or explicit out-of-scope note.
- Acceptance: no claim without a test/probe reference; no delivered feature listed as missing.

### Task 0.2 — `csrf_token NOT NULL` migration (G4, needs A4)
- Backfill legacy null rows (delete them — a token the browser never received is unusable
  anyway), then `ALTER ... SET NOT NULL`.
- Regression test: session insert without csrf_token fails at the DB.
- Acceptance: runtime strictness (kept) + schema strictness; V5.1 addendum note updated.

### Task 0.3 — ADR: single-process rate limiting (G5)
- Decide: accept in-memory limiters as a documented single-instance constraint for pilot,
  or introduce Redis. Recommendation: **accept and document** (ADR-010); the platform is
  single-instance-per-service by design until Epic 7 changes deployment shape. Revisit when
  IaC introduces horizontal scaling.
- Acceptance: ADR merged; `docs/ENVIRONMENT.md` states the constraint; no code change.

### Task 0.4 — Prove CI in GitHub Actions (G12)
- Push a branch, confirm the workflow runs green remotely (Postgres service container).
- Acceptance: a linked green Actions run; badge or note in README.

## Epic 1 — Real Four-Eyes Approvals

Priority: P0 (this is the core governance claim of the product) · Complexity: M · Blocked on: A1

Backlog task 4.5.1. Today `requiredApprovals=2` can be satisfied by the same user clicking
twice; the approver is not recorded. For a treasury control platform this is the most
material remaining application gap.

### Task 1.1 — Approvals schema
- `payment.payment_approvals (tenant_id, payment_id FK, approver_id, approver_display, approved_at, UNIQUE(payment_id, approver_id))`.
- Append-only (`REVOKE UPDATE, DELETE`).

### Task 1.2 — Enforcement in payment-service
- Approve requires a verified approver identity propagated from the gateway session
  (extend the internal-auth signed header to carry acting user id + display name — backlog
  4.3.1's "propagate acting user context").
- Rules, each with its own test:
  - same approver twice → 409 (DB constraint is the backstop);
  - creator cannot approve own payment above threshold (policy field
    `selfApprovalAllowed`, default false);
  - approvals count = distinct approver rows, never a bare counter;
  - auto-approved payments record actor `policy:auto` and are labeled in UI and audit.
- Keep dev-mode (AUTH_REQUIRED=false) working: system identity approves, tests unchanged
  where they don't exercise four-eyes.

### Task 1.3 — UI + audit
- Payment detail shows who approved and when; approve button disabled for creator.
- Audit events carry approver identity.

### Task 1.4 — Adversarial tests
- Same-user double approval via direct payment-service call with forged header → rejected
  (signed context, not client-supplied).
- Creator self-approval via gateway → 403.
- Two distinct approvers → Approved; N-1 approvals → still PendingApproval.

New DB invariant (add to the standard query): no payment has fewer distinct approval rows
than its recorded approvals count.

## Epic 2 — Database Defense in Depth: Roles + RLS

Priority: P1 · Complexity: L · Blocked on: A2

Backlog 1.1.1 (deferred role isolation) + 4.4.1 (RLS). Tenant isolation currently lives
entirely in application WHERE clauses; one missed clause is a cross-tenant leak.

### Task 2.1 — Per-service Postgres roles
- One role per service, `GRANT` only its own schema (+ `platform` where required);
  cross-schema `SELECT` denied.
- Local dev + test harness create roles idempotently; compose updated.
- Test: wallet role `SELECT payment.payments` → permission denied.

### Task 2.2 — Row-level security
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + policy `tenant_id = current_setting('app.tenant_id')::uuid`
  on every tenant-scoped table.
- `withTransaction` sets `app.tenant_id` from verified request context.
- Adversarial test: service code with a deliberately missing WHERE clause still cannot read
  the other tenant's rows (RLS catches it).

### Task 2.3 — Cross-tenant suite extension
- Extend the existing tenant-isolation tests: idempotency-key collision across tenants,
  webhook-driven writes, repair endpoints, audit reads.

Risk note: RLS + `FOR UPDATE` + deferred triggers interact; migrate one schema at a time
(policy → operations → ... → wallet → payment last), full suite green after each.

## Epic 3 — Tamper-Evident Audit

Priority: P1 · Complexity: M · Blocked on: A3

Backlog 4.6.1. Append-only via REVOKE is good; tamper-evidence is what an auditor asks next.

### Task 3.1 — Hash chain
- Add `row_hash` (SHA-256 over canonical event fields + `prev_hash`) and `prev_hash`
  per tenant chain; computed in the insert path.
- Verification script `scripts/verify-audit-chain.mjs` + nightly job (durable jobs infra
  already exists) that alerts (operations alert row) on a break.

### Task 3.2 — Tests + runbook
- Test: manually corrupting a row in a test DB is detected by the verifier.
- Runbook entry: what a chain break means, how to bound the damage, evidence handling.

## Epic 4 — Session and Edge Hardening

Priority: P1 · Complexity: S–M · Blocked on: nothing (A6 only for OIDC scope decision)

### Task 4.1 — Cookie hardening
- `__Host-` prefix for session/csrf cookies when `SESSION_COOKIE_SECURE=true`
  (requires Path=/, no Domain — both already true).
- Session rotation on login (fresh token even if a valid session cookie is presented).
- Idle timeout distinct from absolute TTL (sliding `expires_at` bump with a hard cap).
- Logout clears both cookies with `Max-Age=0` (verify — currently only destroys the row).

### Task 4.2 — Security headers
- CSP for the served UI (self-only; the frontend is dependency-free so this is cheap),
  `frame-ancestors 'none'`, HSTS documented as ingress duty.

### Task 4.3 — OIDC (scope decision needed)
- Recommendation: defer full OIDC to V7 **unless** a design partner requires SSO for pilot.
  If pulled in: generic OIDC code flow against Keycloak in compose (backlog 4.1.1), local
  login retained behind a flag.

## Epic 5 — Provider Adapter Seam + Reconciliation Ingestion

Priority: P1 (interface) / P2 (sandbox rail — blocked on business) · Complexity: L · Blocked on: A5, partner selection

Backlog 5.1.1, first slice of 5.3.1. This epic builds the seam; the real rail plugs in when
credentials exist (which requires the Epic 7 secrets decision first — backlog rule: no real
credential before a secrets manager).

### Task 5.1 — Adapter interface
- `CustodyAdapter { getBalances, submitTransfer, getTransferStatus }` as the first capability;
  the current simulated execution becomes `SimulatedCustodyAdapter` behind it.
- `providers` table gains `capabilities`, `environment ('sandbox'|'prod')`, `adapter` columns.
- Circuit breaker + health polling per provider; provider health drives the existing policy
  provider-route check with live data.
- Saga step 3 calls through the interface; zero behavior change with the simulated adapter
  (full suite must stay green unchanged).

### Task 5.2 — Statement ingestion (simulated first)
- `reconciliation.provider_statements` + normalized statement lines; ingestion endpoint
  (internal) + file-drop script.
- Matching: by provider ref, then amount+date+wallet heuristic; confidence recorded;
  mismatches open exceptions with reason categories (missing-ours, missing-theirs,
  amount-mismatch, fee-mismatch, duplicate).
- Simulated adapter emits statements so the whole recon path is testable without a partner.

### Task 5.3 — Sandbox rail (external dependency — do not start in-repo)
- Blocked on: partner selection (business), secrets manager (Epic 7 / A6).
- When unblocked: sandbox integration, provider refs replace simulated refs, sandbox contract
  tests tagged + credentialed in CI.

## Epic 6 — Money-Path Observability and Alerting

Priority: P1 · Complexity: M · Blocked on: nothing

Backlog 6.3.1, scoped to what matters without a cloud stack: the platform must notice its own
failures before a user does.

### Task 6.1 — Money-path metrics
- Extend `/metrics` (worker + relay + payment): outbox lag (oldest unpublished event age),
  DLQ size, job queue depth, payments per state with time-in-state max, saga step
  failure counts, webhook signature failures, recon exception count/age.

### Task 6.2 — Internal alerting loop
- A watchdog job (durable jobs infra) evaluates thresholds (stuck `Executing` payments,
  outbox lag > N s, DLQ > 0, audit chain break from Epic 3) and writes operations alerts —
  the alerts UI panel already exists and becomes live operational signal.
- Every alert type gets a `docs/RUNBOOKS.md` entry.

### Task 6.3 — Log hygiene probe
- Adversarial test: run a full payment lifecycle, grep captured service logs for session
  tokens, csrf tokens, passwords, webhook secrets → zero hits.

## Epic 7 — Deployment Scaffolding and Infrastructure Boundary

Priority: P2 in-repo / external for the rest · Complexity: M (in-repo) · Blocked on: A6

The honest split. In-repo work prepares; it must never be reported as "infrastructure done".

### Task 7.1 — In-repo (agent can do)
- Container hardening: read-only rootfs, non-root (exists), healthcheck tuning, image scan
  step in CI.
- Per-environment config: `.env.example` variants (dev/staging/prod-shape) validated by the
  existing prod-config gate.
- Terraform skeleton under `infra/` with modules and variables for: managed Postgres (PITR
  flagged), secrets manager references, private networking, WAF-fronted ingress — **plan
  artifacts only**, no cloud resources claimed.

### Task 7.2 — External (human decisions + cloud accounts; tracked, not executed by agent)
- ADR-008 secrets manager, ADR-009 IaC/runtime target, managed Postgres provisioning,
  WAF/DDoS, mTLS or private networking, centralized logs/metrics, on-call/alert routing.
- Definition of done for V6: these are **explicitly listed as not done** in
  `docs/PRODUCTION_READINESS.md` unless a human executes them.

## Epic 8 — Final Verification Pass and Readiness Re-Grade

Priority: REQUIRED · runs after every epic and once at the end

Standard loop (unchanged from V5): `npm run check` → `test:all` → prod-config gate →
migrate + dev + smoke → DB invariants → UI render check → docs reconciliation.

V6 additions to the invariant query:
- approvals integrity (Epic 1): distinct approval rows ≥ recorded approvals count; no
  approval rows by the payment creator where policy forbids it.
- audit chain verification (Epic 3): `scripts/verify-audit-chain.mjs` exits 0.

V6 additions to the adversarial probe list (`docs/RELEASE_CHECKLIST.md`):
- same-user double approval → rejected; creator self-approval → 403.
- cross-schema SELECT under a service role → denied; missing-WHERE query under RLS → empty.
- corrupted audit row → detected by verifier.
- stuck payment → alert row within watchdog interval.
- log grep for secrets → zero hits.

## Suggested Sequence

```text
Epic 0 (truth + debt)          — first; cheap; unblocks honest claims
Epic 1 (four-eyes)             — highest product value; needs A1
Epic 6 (observability)         — parallel-safe with Epic 1 (different surfaces)
Epic 3 (audit chain)           — after Epic 6's watchdog exists (alert delivery)
Epic 4 (session/edge)          — parallel-safe, small
Epic 2 (roles + RLS)           — after 1 & 3 (their schemas exist before policies), migrate schema-by-schema
Epic 5 (adapter seam + recon)  — interface + simulated statements any time; sandbox rail blocked externally
Epic 7 (infra scaffolding)     — in-repo parts last; external parts tracked, not claimed
Epic 8                         — after every epic
```

## Go/No-Go Definition for V6

- **Demo:** GO throughout (each epic keeps the suite green — that's the loop contract).
- **Investor diligence:** GO when Epics 0, 1, 3, 6 complete — governance (four-eyes with
  identity), tamper-evident audit, and self-alerting are the diligence questions V5 could
  not answer.
- **Production money movement:** STILL NO-GO at V6 end. Becomes conditional-GO only after
  Epic 7's **external** items are executed by humans (secrets, managed Postgres + PITR, WAF,
  private networking, monitoring stack, on-call) and a real rail passes sandbox certification
  (Epic 5.3). No document may say otherwise.
