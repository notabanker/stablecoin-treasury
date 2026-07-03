# Production MVP Technical Backlog

Generated: 2026-07-03. Source inputs: full-code audit of this repo (all services, shared packages, frontend, infra) and `docs/FABLE5_GAP_PLANNING_BRIEF.md`.

Verified against code at planning time — the brief's "Recently Fixed Issues" are confirmed real:

- `wallet-service` rejects non-finite/non-positive amounts and inactive wallets ([index.mjs:41-46](../services/wallet-service/src/index.mjs)).
- Execute no longer re-runs policy from `Executing` ([payment-service index.mjs:139-153](../services/payment-service/src/index.mjs)); journals and recon now post **before** `Settled`.
- Journal batches balance and are asserted (`assertBalanced`, [accounting index.mjs:88-94](../services/accounting-service/src/index.mjs)); seed data corrected (credit 42012.4).
- `Review` decisions block approve/execute with 409 `review_required`.
- Policy engine enforces approval thresholds (EUR-converted), provider allowlist, screening requirement, transfer limit EUR conversion, concentration; `POST /policies` validates coherence.
- Compose publishes only gateway `8080`.

These fixes are prototype-grade: no tests, no DB constraints, no recovery tooling. Milestone 0 wraps them in tests; Milestones 1–3 replace their foundations.

## How To Read This Backlog

- **Priority**: P0 = before any pilot with real money · P1 = before regulated design-partner pilot · P2 = before seed-scale production · P3 = later hardening.
- **Complexity**: S = 1–2 days · M = 3–7 days · L = 1–3 weeks · XL = multi-week/multi-team.
- **Risk** = risk of *not* doing it, plus implementation risk where notable.
- Task IDs are stable; dependencies reference them explicitly.

### Sequencing Truths (read before scheduling)

1. **Tenant ID must be born in Milestone 1, not Milestone 4.** Every table created in M1 carries `tenant_id NOT NULL` from its first migration, even while a single hardcoded tenant is used. Retrofitting tenancy onto a live ledger is a rewrite. Auth/RBAC (M4) can come later; the column cannot.
2. **The ledger (M2) is the center of gravity.** The saga (M3), accounting invariants, and reconciliation all hang off ledger transactions. Do not start M3 until ledger postings and the payment state machine are DB-enforced.
3. **Abandon the zero-dependency rule now, deliberately.** M0 introduces a test runner; M1 introduces `pg` + a migration tool + a schema validator. Record it as ADR-001 rather than letting dependencies accrete silently.
4. **Four-eyes control is meaningless before identity.** Tasks 4.5.x are blocked by 4.1.x. Until then, the approval counter is a demo affordance — say so in the UI.
5. **Anything currently "best-effort" (audit posts, alerts, recon exceptions from `bestEffortPost`) is a silent-loss channel** until the outbox (M3) exists. Acceptable for a prototype; listed as explicit debt in 3.1.

---

## Milestone 0: Prototype Stabilization

Goal: make the current prototype testable and fix remaining audit findings without redesigning foundations. Everything here survives into the production stack or directly protects the pilot path.

### Epic 0.1: Test Harness And Regression Coverage For Recent Fixes

#### Task 0.1.1: Introduce test framework and structure
- Priority: P0
- Risk: High — every money-path fix in the repo is currently unverified by any test.
- Complexity: S
- Dependencies: none
- Components: `package.json`, new `tests/` tree, ADR-001
- Subtasks:
  - [ ] Adopt `node:test` + `node:assert/strict` (zero new deps; revisit at M1 if insufficient).
  - [ ] Create `tests/unit/`, `tests/integration/`, `tests/concurrency/`.
  - [ ] Add `npm test` (unit) and `npm run test:integration` (spins services on ephemeral ports with `DATA_DIR` pointed at a temp dir).
  - [ ] Add test helper that boots a service in-process with an isolated store.
  - [ ] Write ADR-001: dependency policy (what may be added, why, review gate).
- Acceptance Criteria:
  - [ ] `npm test` runs green locally with zero network access.
  - [ ] Integration tests never touch `.data/`.
- Tests: the harness itself (a trivial passing test per suite dir).
- Definition of Done:
  - [ ] CI-runnable single command; documented in README.

#### Task 0.1.2: Regression tests for money-safety fixes
- Priority: P0
- Risk: Critical — these encode the invariants that were violated last week.
- Complexity: M
- Dependencies: 0.1.1
- Components: `services/wallet-service`, `services/payment-service`, `services/accounting-service`, `services/policy-service`
- Subtasks:
  - [ ] Wallet debit: rejects `"abc"`, `NaN`, `Infinity`, `-1`, `0`, missing amount; rejects inactive wallet; idempotent replay returns identical operation; balance never becomes non-finite.
  - [ ] Journal generation: cash credit = amount + fee; batch balances; `assertBalanced` fires on hand-built unbalanced batch; dedupe by paymentId returns existing lines.
  - [ ] Policy: each of the 7 checks flips Clear/Review/Blocked at its boundary values; `POST /policies` rejects negative limits, `approvalThreshold > secondApprovalThreshold`, `concentrationLimit` outside (0,1].
  - [ ] Approve/execute: `Review` decision → 409 `review_required`; `Blocked` → status `Blocked`; resume-from-`Executing` skips re-evaluation and cannot double-debit (assert one debit op in wallet store after two execute calls).
  - [ ] Full lifecycle integration test: create → approve → execute → settled, asserting wallet balance, 3 balanced journal lines, matched recon row.
- Acceptance Criteria:
  - [ ] Reverting any one of the recent fixes makes at least one test fail.
- Tests: are the deliverable.
- Definition of Done:
  - [ ] All green; failure messages name the violated invariant.

#### Task 0.1.3: Concurrency tests that expose known races
- Priority: P0
- Risk: High — races exist today (see 0.2.1, 0.2.2); tests must exist before and after the fix.
- Complexity: M
- Dependencies: 0.1.1
- Components: `services/payment-service`, `packages/shared/data.mjs`
- Subtasks:
  - [ ] Fire N=20 parallel `POST /payments` with the **same** idempotency key → assert exactly 1 payment exists (currently fails: check-then-act across awaits at [payment-service index.mjs:38-40 vs 77-80](../services/payment-service/src/index.mjs)).
  - [ ] Fire N=20 parallel creates with distinct keys → assert all `reference` values unique (currently fails: `nextPaymentReference` races).
  - [ ] Parallel execute of two approved payments draining one wallet → assert no overdraft, loser fails with 409.
  - [ ] Parallel approve of a 2-approval payment → assert approvals never exceed requiredApprovals.
- Acceptance Criteria:
  - [ ] Tests marked expected-fail until 0.2.1/0.2.2 land, then flipped to must-pass.
- Definition of Done:
  - [ ] Races demonstrably closed by the paired fixes.

### Epic 0.2: Remaining Audit Bug Fixes

#### Task 0.2.1: Close the payment-creation idempotency race
- Priority: P0
- Risk: Critical — duplicate payments under retry/double-click despite idempotency keys.
- Complexity: S
- Dependencies: 0.1.3 (test first)
- Components: [services/payment-service/src/index.mjs](../services/payment-service/src/index.mjs)
- Subtasks:
  - [ ] Reserve the idempotency key synchronously before the first `await` (placeholder entry with state `pending`), so concurrent requests see the reservation.
  - [ ] Concurrent duplicate requests either wait-and-return the winner's payment or receive 409 `idempotency_in_progress` (pick one; document).
  - [ ] Release reservation on failure so a failed create can be retried with the same key.
  - [ ] Detect request-hash mismatch: same key + different body → 422 `idempotency_key_reuse`.
- Acceptance Criteria:
  - [ ] 0.1.3 duplicate-create test passes; same-key-different-body returns 422.
- Tests: concurrency suite + unit tests for reservation/release/mismatch.
- Definition of Done:
  - [ ] No code path records the key after an `await` gap without a prior reservation.

#### Task 0.2.2: Unique payment references
- Priority: P1
- Risk: Medium — colliding `PMT-xxxx` references corrupt reconciliation and audit joins.
- Complexity: S
- Dependencies: none (superseded by DB sequence in 1.2.3 — implement minimally)
- Components: [packages/shared/data.mjs:428-434](../packages/shared/data.mjs)
- Subtasks:
  - [ ] Allocate the reference inside the same synchronous section as the idempotency reservation (0.2.1), or derive from a monotonic per-store counter persisted in state.
  - [ ] Add collision assertion in createPayment as a backstop.
- Acceptance Criteria:
  - [ ] 0.1.3 uniqueness test passes at N=50 parallel creates.
- Definition of Done: counter survives restart (persisted in store).

#### Task 0.2.3: HTTP framework hardening (`packages/shared/http.mjs`)
- Priority: P0 (crash vector), rest P2
- Risk: High — a mid-stream static read error crashes the gateway process.
- Complexity: S
- Dependencies: none
- Components: [packages/shared/http.mjs](../packages/shared/http.mjs)
- Subtasks:
  - [ ] Attach `error` handler to `createReadStream(...)` ([line 211](../packages/shared/http.mjs)): destroy the response, log, do not throw.
  - [ ] Fix prefix check ([line 203](../packages/shared/http.mjs)): compare against `root + path.sep`.
  - [ ] Swap timeout relationship (headersTimeout < requestTimeout, [lines 83-84](../packages/shared/http.mjs)).
  - [ ] Change CORS default from `*` to same-origin-only; require explicit `CORS_ORIGIN` to widen ([line 226](../packages/shared/http.mjs)); update `.env.example` and compose.
  - [ ] Delete dead exports `created`, `noContent`, `resettable` or add call sites; dead API surface invites misuse.
  - [ ] Record metrics for OPTIONS and draining responses.
- Acceptance Criteria:
  - [ ] Killing a static file mid-transfer does not exit the process (test with a fifo or deleted-after-stat file).
  - [ ] `GET` on a sibling directory of webRoot (`apps/webX`) returns 404.
- Tests: unit tests for `serveStatic` traversal/prefix cases; crash-resilience integration test.
- Definition of Done: no unhandled `error` events reachable from a request.

#### Task 0.2.4: Durable store recovery (`packages/shared/store.mjs`)
- Priority: P1
- Risk: High — one corrupt/truncated JSON file = infinite crash-loop under `restart: unless-stopped`.
- Complexity: S
- Dependencies: none (replaced wholesale in M1; this protects the interim)
- Components: [packages/shared/store.mjs:32-40](../packages/shared/store.mjs)
- Subtasks:
  - [ ] On parse failure: quarantine the corrupt file to `<name>.corrupt.<ts>.json`, log loudly, reseed. Never crash-loop.
  - [ ] Write a `.bak` of the previous state on each save; attempt `.bak` restore before reseeding.
  - [ ] Add fsync of file and directory in `atomicWriteJson` (durability claim in docs is currently false).
- Acceptance Criteria:
  - [ ] Truncating a state file mid-write then restarting yields a running service with quarantined file + restored or reseeded state.
- Tests: unit tests for corrupt-load, bak-restore, quarantine naming.
- Definition of Done: crash-loop impossible from state-file corruption.

#### Task 0.2.5: Service client correctness (`packages/shared/service-client.mjs`)
- Priority: P2
- Risk: Medium — unbounded body reads hang callers past all timeouts; error taxonomy misdiagnoses.
- Complexity: S
- Dependencies: none
- Components: [packages/shared/service-client.mjs:48-60](../packages/shared/service-client.mjs)
- Subtasks:
  - [ ] Keep the abort timer alive through `response.text()`; clear only after body fully read.
  - [ ] Non-JSON body on 2xx → explicit `invalid_upstream_response` (not 502 upstream_unavailable).
  - [ ] Non-JSON body on retryable status → still retry (parse currently throws before the retry branch).
  - [ ] Stop spreading client-only options (`retryable`, `idempotencyKey`, `timeoutMs`) into `fetch` init.
- Acceptance Criteria:
  - [ ] A stalled upstream body aborts at the configured timeout.
- Tests: unit tests with a stub server that stalls bodies / returns HTML.
- Definition of Done: every failure mode maps to a distinct, correct error code.

#### Task 0.2.6: Reconciliation service input validation and real aging
- Priority: P2
- Risk: Low-Medium — 500s on malformed input; `ageHours` is fiction (always 0).
- Complexity: S
- Dependencies: none
- Components: [services/reconciliation-service/src/index.mjs](../services/reconciliation-service/src/index.mjs)
- Subtasks:
  - [ ] Validate `body.payment` on `POST /reconciliation/exceptions` (422, matching `/simulate`).
  - [ ] Store `createdAt` on every row; compute age from timestamp at read time; drop stored `ageHours`.
  - [ ] Stop hardcoding `owner: "Marta Klein"` on resolve; accept an `owner`/actor field (placeholder until identity, M4).
- Acceptance Criteria: malformed exception posts return 422; ages increase over time.
- Tests: unit tests for validation and age computation.
- Definition of Done: no TypeError-to-500 path remains in this service.

#### Task 0.2.7: Frontend failure visibility and stuck-payment actions
- Priority: P1
- Risk: High for pilot trust — refresh failures are currently silent; `Executing`/`Failed` payments are dead ends in the UI.
- Complexity: M
- Dependencies: none (repair semantics deepen in 3.3)
- Components: [apps/web/main.js](../apps/web/main.js)
- Subtasks:
  - [ ] Render `state.error` when data already exists (stale banner: "Showing data from HH:MM — refresh failed"), and toast on failed refresh ([main.js:168-181, 234-238](../apps/web/main.js)).
  - [ ] Add "Retry execution" action for `Executing` payments (execute is resume-safe now) and a visible explanation for `Failed` ([main.js:527-538](../apps/web/main.js)).
  - [ ] Add fetch timeout (AbortController, ~10s) so a hung gateway doesn't freeze the busy state forever.
  - [ ] Remove the duplicated `eurRates` table; serve rates from the gateway in `/api/state` so client and server cannot drift.
- Acceptance Criteria:
  - [ ] Kill the gateway mid-session → UI shows stale-data banner within one refresh attempt.
  - [ ] An `Executing` payment can be driven to `Settled` from the UI alone.
- Tests: add browser e2e smoke (Playwright) for these two flows — first e2e tests in the repo.
- Definition of Done: no silent failure mode reachable from the six UI views.

#### Task 0.2.8: Smoke test safety and coverage
- Priority: P1
- Risk: Medium — `npm run smoke` resets whatever `SMOKE_BASE_URL` points at, twice.
- Complexity: S
- Dependencies: 0.1.1
- Components: [scripts/smoke.mjs](../scripts/smoke.mjs)
- Subtasks:
  - [ ] Refuse non-loopback hosts unless `SMOKE_ALLOW_REMOTE=1` is set; print the target and require it to answer `/health` with expected service name before reset.
  - [ ] Fix brittle `base.replace("/api", "/ready")` URL derivation.
  - [ ] Add failure-path assertions: blocked counterparty payment ends `Blocked`; over-limit payment `Blocked`; `Review` counterparty cannot be approved (409).
- Acceptance Criteria: smoke against a URL that isn't this app aborts before mutating anything.
- Definition of Done: smoke covers happy path + 3 failure paths, still < 30s runtime.

#### Task 0.2.9: Decide and test zero-approval auto-approve semantics
- Priority: P0 (it's a control-bypass decision)
- Risk: High — the recent threshold fix means sub-`approvalThreshold` payments are auto-`Approved` at creation ([payment-service index.mjs:73-75, 217-226](../services/payment-service/src/index.mjs)) and immediately executable. That may be intended; it must be deliberate.
- Complexity: S
- Dependencies: none
- Components: `services/payment-service`, `services/policy-service`, product decision record
- Subtasks:
  - [ ] Record the decision (ADR-002): straight-through processing below threshold — yes/no, and whether policy `requireScreening` still gates it (it does today via evaluate; add test).
  - [ ] If yes: UI must label auto-approved payments; audit event must say "Auto-approved by policy" not a human name.
  - [ ] Test the boundary: amount exactly at `approvalThreshold` EUR-equivalent requires 1 approval; one cent below requires 0.
- Acceptance Criteria: boundary tests pass; audit trail distinguishes auto vs human approval.
- Definition of Done: ADR merged; tests green.

#### Task 0.2.10: Gateway idempotency-key fallback hardening
- Priority: P1
- Risk: Medium — fallback key is `gateway:${requestId}` where requestId is the **client-supplied** `x-request-id` ([api-gateway index.mjs:33](../services/api-gateway/src/index.mjs) + [http.mjs:20](../packages/shared/http.mjs)); two clients reusing a request id silently share a payment.
- Complexity: S
- Dependencies: none
- Components: `services/api-gateway`, `packages/shared/http.mjs`
- Subtasks:
  - [ ] Never derive idempotency from client-controlled request IDs: if the client sends no `Idempotency-Key`, generate a UUID (no dedupe) or reject with 428 — pick and document (recommend 428 for `/api/payments`; UI always sends one).
  - [ ] Always generate a fresh server-side request id; log the client's id as a separate correlation field.
- Acceptance Criteria: two requests with identical `x-request-id` and no idempotency key create two payments (or both 428).
- Tests: integration test at the gateway.
- Definition of Done: request identity and idempotency identity are separate concepts in code.

### Epic 0.3: Interim Service Contracts

#### Task 0.3.1: Write per-service API contracts as they exist
- Priority: P1
- Risk: Medium — M1–M3 rewrites need a baseline contract to preserve/deliberately break.
- Complexity: M
- Dependencies: none
- Components: new `docs/contracts/*.md` (or minimal OpenAPI YAML), all services
- Subtasks:
  - [ ] Document every endpoint: method, path, request/response shape, error codes, idempotency behavior, side effects emitted.
  - [ ] Mark each field as load-bearing or legacy (e.g., gateway still returns `activeView`/`selectedPaymentId` the client ignores).
  - [ ] Add contract tests asserting responses match documented shapes (loose structural checks now; strict schemas arrive in 1.3.3).
- Acceptance Criteria: a new engineer can call any service correctly from the doc alone.
- Definition of Done: contract tests in CI; drift fails the build.

---

## Milestone 1: Database Foundation

Goal: PostgreSQL with per-service schemas, migrations, constraints, tenant column from day one. No business-logic redesign yet — port current behavior onto real persistence.

### Epic 1.1: PostgreSQL Infrastructure And Migration Tooling

#### Task 1.1.1: Add Postgres to local and compose environments
- Priority: P0
- Risk: Low implementation / Critical omission.
- Complexity: S
- Dependencies: ADR-001 (0.1.1)
- Components: `docker-compose.yml`, `scripts/dev.mjs`, `.env.example`
- Subtasks:
  - [ ] Add `postgres:16` service to compose with named volume, healthcheck, non-default password sourced from env.
  - [ ] Local dev: document `docker compose up postgres` or add embedded fallback; `scripts/dev.mjs` waits for DB readiness.
  - [ ] One database, **schema per service** (`wallet`, `payment`, `policy`, `compliance`, `accounting`, `reconciliation`, `operations`, `platform`, `identity`), each service's DB role can only touch its own schema. Record as ADR-003 with the database-per-service upgrade path.
- Acceptance Criteria: `npm run dev` boots services connected to Postgres; cross-schema access denied at role level.
- Tests: role-permission test (wallet role cannot `SELECT` from `payment.*`).
- Definition of Done: compose + local both green; credentials never hardcoded.

#### Task 1.1.2: Migration tooling and conventions
- Priority: P0
- Risk: High — schema drift without migrations is unrecoverable later.
- Complexity: S
- Dependencies: 1.1.1
- Components: new `db/migrations/<service>/`, `package.json`
- Subtasks:
  - [ ] Adopt a migration tool (`node-pg-migrate` or `dbmate`; decide in ADR-003).
  - [ ] Numbered, forward-only migrations per service schema; `npm run migrate` / `migrate:status`.
  - [ ] Migration test: apply all from scratch, assert schema snapshot; run in CI.
  - [ ] Seed scripts separated from migrations (`db/seeds/`), idempotent, dev/test only.
- Acceptance Criteria: fresh clone → `npm run migrate && npm run seed` → working stack.
- Definition of Done: CI applies migrations against a throwaway DB per run.

### Epic 1.2: Service Schemas With Constraints

Every table in this epic gets: `tenant_id UUID NOT NULL`, `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`, and `updated_at` where mutable. A single seeded tenant row (`identity.tenants`) satisfies FKs until M4.

#### Task 1.2.1: Identity skeleton schema (tenants only, now)
- Priority: P0
- Risk: Critical if skipped — see Sequencing Truth #1.
- Complexity: S
- Dependencies: 1.1.2
- Components: `db/migrations/identity/`
- Subtasks:
  - [ ] `identity.tenants (id, name, status, created_at)` + seeded default tenant.
  - [ ] Defer `users`, `roles`, `permissions`, `sessions` table creation to 4.1 but reserve the schema and write the ERD now so FKs are planned.
- Acceptance Criteria: every subsequent table FK-references `identity.tenants`.
- Definition of Done: ERD in `docs/db/identity.md`.

#### Task 1.2.2: Wallet schema
- Priority: P0
- Risk: Critical — this is where money lives.
- Complexity: M
- Dependencies: 1.2.1
- Components: `db/migrations/wallet/`
- Subtasks:
  - [ ] `legal_entities (tenant_id, name, jurisdiction, base_currency, erp_code)`.
  - [ ] `assets (tenant_id, code UNIQUE per tenant, name, currency CHAR(3), issuer, chain, classification, status CHECK IN (...), risk)`.
  - [ ] `wallets (tenant_id, entity_id FK, provider_id, asset_code FK, address, custody, status CHECK, balance NUMERIC(20,2) NOT NULL CHECK (balance >= 0))` — balance stays a column until the ledger (2.1) makes it derived; the CHECK makes overdraft a DB error today.
  - [ ] `debit_operations (tenant_id, idempotency_key UNIQUE, wallet_id FK, amount NUMERIC CHECK (amount > 0), balance_after, created_at)` — port of the JSON idempotency map, now constraint-backed.
  - [ ] All money columns `NUMERIC`, never float. Amounts non-negative by CHECK. Currency/asset codes FK-validated.
- Acceptance Criteria: inserting a negative balance or unknown asset fails at the DB, not the app.
- Tests: constraint tests per table (attempt each forbidden state).
- Definition of Done: wallet-service reads/writes exclusively through this schema (see 1.3).

#### Task 1.2.3: Payment schema
- Priority: P0
- Complexity: M
- Dependencies: 1.2.1, 1.2.2
- Components: `db/migrations/payment/`
- Subtasks:
  - [ ] `payments (tenant_id, reference UNIQUE per tenant — DB sequence-backed, killing 0.2.2's stopgap, type, source_wallet_id, counterparty_id, asset_code, amount NUMERIC CHECK (amount > 0), fee NUMERIC CHECK (fee >= 0), status CHECK constrained to the 2.2 state list, approvals_required int, screen_result, memo, provider_ref, chain_ref, settled_at, created_at, updated_at, row_version int)`.
  - [ ] `payment_events (payment_id FK, from_status, to_status, reason_code, actor, at)` — append-only (`REVOKE UPDATE, DELETE`).
  - [ ] `payment_approvals (payment_id FK, approver_id, approved_at, UNIQUE(payment_id, approver_id))` — the unique constraint is the four-eyes backstop, live before identity arrives.
  - [ ] `idempotency_keys (tenant_id, key, action, request_hash, payment_id, response_snapshot JSONB, expires_at, UNIQUE(tenant_id, key, action))`.
  - [ ] `payment_execution_attempts (payment_id, attempt_no, step, outcome, error, at)`.
- Acceptance Criteria: duplicate reference, duplicate approval by same approver, and duplicate idempotency key all fail at DB level.
- Tests: constraint suite; event append-only test (UPDATE denied).
- Definition of Done: schema deployed; app wiring in 1.3.

#### Task 1.2.4: Policy, compliance, accounting, reconciliation, operations schemas
- Priority: P0 (accounting, operations/audit), P1 (rest)
- Complexity: L
- Dependencies: 1.2.1
- Components: `db/migrations/{policy,compliance,accounting,reconciliation,operations}/`
- Subtasks:
  - [ ] policy: `policy_versions (tenant_id, version, body JSONB, effective_from, created_by, UNIQUE(tenant_id, version))`, `policy_decisions (tenant_id, payment_id, policy_version, input_hash, checks JSONB, decision, detail, at)` — decisions append-only. Porting note: current single mutable policy object becomes version 1.
  - [ ] compliance: `counterparties`, plus empty-but-migrated `screening_requests`, `screening_results`, `review_cases` for M5.
  - [ ] accounting: `journal_batches (tenant_id, payment_id UNIQUE, status CHECK, posted_at)`, `journal_lines (batch_id FK, entity_id, account, debit NUMERIC CHECK (debit >= 0), credit NUMERIC CHECK (credit >= 0), currency, CHECK (debit = 0 OR credit = 0))`, plus a **deferred constraint trigger asserting SUM(debit) = SUM(credit) per batch at commit** — the `assertBalanced` invariant moves into the database. `export_batches`, `export_attempts` tables now, used in M5.
  - [ ] reconciliation: `reconciliation_exceptions` / `reconciliation_matches` with `payment_id`, `source`, `status CHECK`, timestamps (aging computed, per 0.2.6); `provider_statements` empty until M5.
  - [ ] operations: `providers`, `incidents`, `alerts`, and `audit_events (tenant_id, actor, action, object, detail, request_id, at)` append-only via REVOKE — full tamper-evidence in 4.6.
- Acceptance Criteria: an unbalanced journal batch cannot be committed even by raw SQL under the service role.
- Tests: trigger test (unbalanced insert in a tx → commit fails); append-only tests for decisions and audit.
- Definition of Done: all seven service schemas migrated and seeded.

### Epic 1.3: Data Access Layer And Service Port

#### Task 1.3.1: Shared DB module replacing `store.mjs`
- Priority: P0
- Complexity: M
- Dependencies: 1.1.x
- Components: new `packages/shared/db.mjs`, retire [packages/shared/store.mjs](../packages/shared/store.mjs)
- Subtasks:
  - [ ] `pg` pool per service with schema-scoped `search_path` and role; health check queries the pool.
  - [ ] `withTransaction(fn)` helper; all mutations run inside transactions.
  - [ ] Statement timeout + pool sizing via env; structured query logging (no values logged — redaction from day one).
- Acceptance Criteria: no service imports `store.mjs` after this epic; `.data/` used only by a `--legacy` fallback flag if kept at all.
- Tests: transaction rollback test; pool exhaustion behavior test.
- Definition of Done: `store.mjs` deleted or clearly quarantined.

#### Task 1.3.2: Port each service to Postgres (7 subtasks, one per service)
- Priority: P0
- Risk: High implementation risk — behavior must not drift; contracts from 0.3.1 are the safety net.
- Complexity: XL (roughly M per service; wallet/payment hardest)
- Dependencies: 1.2.x, 1.3.1, 0.3.1
- Components: every `services/*/src/index.mjs`
- Subtasks:
  - [ ] Port order: policy → compliance → operations → reconciliation → accounting → wallet → payment (dependencies last, so their downstreams are already stable).
  - [ ] Wallet debit becomes `UPDATE ... SET balance = balance - $1 WHERE id = $2 AND balance >= $1` + insert into `debit_operations`, one transaction — the DB now enforces no-overdraft under concurrency.
  - [ ] Payment create/approve/execute wrap status change + event insert + idempotency row in one transaction with `SELECT ... FOR UPDATE` on the payment row.
  - [ ] Contract tests from 0.3.1 pass unchanged against every ported service.
- Acceptance Criteria: `npm run smoke` and full 0.1.2 suites pass on Postgres; concurrency suite (0.1.3) passes without app-level mutexes.
- Tests: everything existing, plus per-service integration tests against a test DB.
- Definition of Done: JSON persistence gone from the runtime path.

#### Task 1.3.3: Request/response schema validation layer
- Priority: P1
- Complexity: M
- Dependencies: 1.3.2 (can start in parallel with porting)
- Components: `packages/shared/http.mjs`, all services, `docs/contracts/`
- Subtasks:
  - [ ] Adopt a schema validator (zod or ajv — ADR-004); define request/response schemas per endpoint from the 0.3.1 contracts.
  - [ ] Validate at the route layer: 422 with field-level errors; standardized error envelope `{error, message, details[], requestId}` everywhere.
  - [ ] Generate OpenAPI from schemas; publish at `/api/docs` (replacing the hand-listed endpoint array).
- Acceptance Criteria: fuzzing any endpoint with malformed JSON never yields a 500 caused by a TypeError.
- Tests: schema round-trip tests; negative-input matrix per endpoint.
- Definition of Done: no hand-rolled `Number(body.x || 0)`-style parsing remains.

### Epic 1.4: Test Database Harness And Backups

#### Task 1.4.1: Test DB lifecycle
- Priority: P0
- Complexity: S
- Dependencies: 1.1.2
- Subtasks:
  - [ ] Per-test-run ephemeral database (template DB restore or schema drop/recreate), parallel-safe.
  - [ ] `npm run test:integration` provisions, migrates, seeds, runs, destroys.
- Definition of Done: integration tests runnable concurrently on one machine.

#### Task 1.4.2: Backup, restore, retention baseline
- Priority: P1 (plan + scripts), P2 (managed PITR — lands with 6.2)
- Complexity: M
- Subtasks:
  - [ ] `pg_dump` scheduled script + documented restore procedure; restore drill executed once and written up in `docs/runbooks/restore.md`.
  - [ ] Retention policy stated per data class (payments/audit: long; idempotency keys: expiring).
  - [ ] PITR requirements documented for the managed-Postgres decision in 6.2.
- Definition of Done: a named person has restored a backup successfully by following only the runbook.

---

## Milestone 2: Ledger And Payment Safety

Goal: money movement becomes append-only double-entry; payment lifecycle becomes a real state machine; both enforced in the database.

### Epic 2.1: Append-Only Double-Entry Ledger

#### Task 2.1.1: Ledger schema and posting rules
- Priority: P0
- Risk: Critical — this is the "money cannot disappear" mechanism.
- Complexity: L
- Dependencies: 1.2.2, 1.3.2 (wallet on Postgres)
- Components: `db/migrations/wallet/`, `services/wallet-service`
- Subtasks:
  - [ ] `ledger_accounts (tenant_id, entity_id, wallet_id NULLABLE, asset_code, account_type CHECK IN ('wallet','fees','settlement_clearing','intercompany',...), UNIQUE(tenant_id, wallet_id, asset_code, account_type))`.
  - [ ] `ledger_transactions (tenant_id, idempotency_key UNIQUE, description, payment_id, created_at)` — append-only.
  - [ ] `ledger_entries (transaction_id FK, account_id FK, direction CHECK IN ('debit','credit'), amount NUMERIC CHECK (amount > 0), asset_code)` — append-only; deferred trigger asserts per-transaction, per-asset SUM(debits) = SUM(credits).
  - [ ] Posting rule doc `docs/db/ledger-postings.md`: payment execution = debit wallet account (amount+fee), credit settlement_clearing (amount), credit fees (fee) — mapped 1:1 to the accounting journal semantics so recon between ledger and journals is trivial.
  - [ ] `wallet_balance_snapshots (account_id, balance, as_of_entry_id)` maintained by the posting code; rebuild tool `scripts/rebuild-balances.mjs` recomputes from entries and diffs.
- Acceptance Criteria:
  - [ ] `UPDATE`/`DELETE` on ledger tables denied to service roles.
  - [ ] Unbalanced transaction cannot commit.
  - [ ] Rebuild tool output matches snapshots after any test suite run.
- Tests: invariant suite (balanced, append-only, idempotent posting by key); property-style test posting random valid transactions and asserting global debits = credits.
- Definition of Done: every balance movement exists as immutable entries.

#### Task 2.1.2: Wallet balance becomes ledger-derived
- Priority: P0
- Complexity: M
- Dependencies: 2.1.1
- Components: `services/wallet-service`
- Subtasks:
  - [ ] `POST /wallets/:id/debit` becomes a ledger posting (existing idempotency key maps to `ledger_transactions.idempotency_key`); mutable `wallets.balance` column becomes a read-model view of the snapshot, then is dropped.
  - [ ] Add credit/transfer posting endpoint (internal) — destination side of intra-group payments finally exists; the money-disappears gap from the audit closes here.
  - [ ] Migration backfills opening-balance ledger transactions from current wallet balances.
- Acceptance Criteria: brief §8 "No wallet balance is directly mutable outside ledger-posting code" is true; grep proves no `UPDATE wallets SET balance` outside the posting module.
- Tests: overdraft-under-concurrency (DB-level); malformed-request corruption test (port of the NaN regression, now impossible by type).
- Definition of Done: `debitOperations` map retired in favor of ledger idempotency.

### Epic 2.2: Payment State Machine

#### Task 2.2.1: Formal states, transition table, enforcement
- Priority: P0
- Complexity: L
- Dependencies: 1.2.3, 1.3.2
- Components: new `packages/shared/payment-states.mjs`, `services/payment-service`, migration
- Subtasks:
  - [ ] Adopt states: `Draft, PendingApproval, Approved, Executing, SettlementPending, Settled, Failed, RepairRequired, Cancelled, Rejected, Expired`. Migration maps current strings (`"Pending approval"` → `PendingApproval`, `"Blocked"` → `Rejected` with reason `policy_blocked`).
  - [ ] Single transition function: `transition(payment, to, {reason, actor})` — validates against the table, writes `payment_events`, bumps `row_version`. All status writes go through it; direct status assignment banned by lint rule.
  - [ ] DB trigger validates (from, to) pairs against a transitions table as defense in depth.
  - [ ] Reason codes enum: `policy_blocked, review_required, insufficient_balance, provider_timeout, accounting_failed, operator_repair, expired_unapproved, ...`.
  - [ ] Auto-expiry job (simple interval for now; durable job in M3): `PendingApproval` older than configurable TTL → `Expired`.
- Acceptance Criteria: every allowed transition has a test; every disallowed pair is rejected in app AND by the DB trigger.
- Tests: full transition matrix (allowed + representative disallowed); event-emission assertions.
- Definition of Done: `payment_events` fully reconstructs any payment's history.

#### Task 2.2.2: Recovery paths for stuck states
- Priority: P0
- Complexity: M
- Dependencies: 2.2.1 (full automation arrives with 3.2/3.3)
- Subtasks:
  - [ ] `Executing` older than threshold → surfaced as `RepairRequired` with reason; operator endpoints: retry-execution, mark-failed-with-compensation (posts reversing ledger transaction), force-settle-with-evidence.
  - [ ] `Failed` gets defined exits: retry (back to `Approved` if debit never committed) or compensate + `Cancelled`.
  - [ ] Compensation = new reversing ledger transaction; never mutation or deletion.
- Acceptance Criteria: the audit's original lost-funds scenario (debit committed, response lost) is drivable to a consistent end state from operator endpoints, with the ledger balancing throughout.
- Tests: simulate crash-after-debit; assert repair path restores invariants.
- Definition of Done: no terminal-dead-end states without a documented operator action.

### Epic 2.3: Idempotency And Concurrency, Constraint-Backed

#### Task 2.3.1: Idempotency table semantics everywhere
- Priority: P0
- Complexity: M
- Dependencies: 1.2.3, 2.1.1
- Subtasks:
  - [ ] All command endpoints (create, approve, execute, cancel, debit, journal-create, recon-create) consult `idempotency_keys` (or ledger/batch unique keys) inside the mutation transaction.
  - [ ] Response snapshot stored so replays return the original response byte-for-byte.
  - [ ] Request-hash mismatch → 422; expiry sweeper job.
  - [ ] Gateway requires `Idempotency-Key` on `POST /api/payments` (finishing 0.2.10).
- Acceptance Criteria: brief §8 "every command idempotent" holds; replay of any recorded request produces zero new rows anywhere.
- Tests: replay matrix across all commands; concurrency suite rerun (0.1.3, now DB-backed).
- Definition of Done: JSON idempotency maps fully retired.

#### Task 2.3.2: Row-level locking discipline
- Priority: P0
- Complexity: S
- Dependencies: 1.3.2
- Subtasks:
  - [ ] `SELECT ... FOR UPDATE` on payment row for approve/execute/cancel; on ledger account snapshot row for postings; documented lock-ordering (payment → wallet) to prevent deadlock.
  - [ ] `row_version` optimistic check for gateway-originated updates.
- Tests: deadlock test (opposite-order operations), duplicate-approval race, execute-vs-cancel race.
- Definition of Done: concurrency suite green at N=100 parallel operations.

---

## Milestone 3: Async Workflow Foundation

Goal: money movement stops being a synchronous HTTP chain. Effects become events; retries become infrastructure.

### Epic 3.1: Transactional Outbox / Inbox

#### Task 3.1.1: Outbox tables and relay
- Priority: P0
- Complexity: L
- Dependencies: 1.3.2, 2.2.1
- Components: `db/migrations/platform/` (per-schema `outbox_events`), new `services/relay-worker` or in-process relay per service
- Subtasks:
  - [ ] `outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload JSONB, created_at, published_at NULLABLE)` in each writing service's schema; event insert shares the transaction with the state change.
  - [ ] Relay: poll unpublished, deliver to consumers (HTTP push to start; queue tech decision deferred to ADR-005/6.2 — Postgres-backed delivery is fine at pilot scale), mark published. At-least-once.
  - [ ] `inbox_events (tenant_id, event_id UNIQUE, consumer, processed_at)` per consumer for exactly-once **effect**.
  - [ ] Event catalog with versioned JSON schemas: `payment.created|approved|rejected|execution_requested|settled`, `wallet.debit_committed`, `accounting.journal_created`, `reconciliation.match_created|exception_opened`, `audit.event_recorded`.
  - [ ] Replace every `bestEffortPost` ([payment-service index.mjs:228-241](../services/payment-service/src/index.mjs)) — audit events, alerts, recon exceptions currently drop silently on failure; after this task they are durable.
- Acceptance Criteria: killing operations-service during payment creation loses zero audit events (delivered after restart).
- Tests: relay crash/restart tests; duplicate-delivery consumed-once tests; schema-validation on publish.
- Definition of Done: no fire-and-forget side effects remain in any money path.

#### Task 3.1.2: Durable jobs
- Priority: P0
- Complexity: M
- Dependencies: 3.1.1
- Subtasks:
  - [ ] `platform.jobs (id, tenant_id, type, payload, status, run_at, attempts, max_attempts, last_error)` + `job_attempts`; worker with `FOR UPDATE SKIP LOCKED` polling.
  - [ ] Retry with backoff + jitter; exhausted jobs → dead-letter status + alert event.
  - [ ] Move payment auto-expiry (2.2.1) and idempotency sweeper (2.3.1) onto jobs.
- Definition of Done: workers restart-safe; no in-memory timers carrying business state.

### Epic 3.2: Payment Execution Saga

#### Task 3.2.1: Convert execution to an orchestrated saga
- Priority: P0
- Risk: Critical — this removes the class of bug behind the original lost-funds finding.
- Complexity: XL
- Dependencies: 2.1.2, 2.2.1, 3.1.1, 3.1.2
- Components: `services/payment-service` (orchestrator), all downstream services
- Subtasks:
  - [ ] `POST /payments/:id/execute` becomes: validate + transition to `Executing` + enqueue `execute-payment` job, return 202 with the payment.
  - [ ] Saga steps, each idempotent, each recorded in `payment_execution_attempts`: (1) policy final check → (2) ledger debit posting (reserve) → (3) provider submission [simulated adapter until M5] → transition `SettlementPending` → (4) on provider confirmation: journal batch → recon match → transition `Settled` → emit `payment.settled`.
  - [ ] Compensation table per step: provider submission failed → reverse ledger posting, transition `Failed(reason)`; journal failed after settlement confirmed → retry forever + `RepairRequired` alert after N attempts (money moved; booking must catch up — never compensate money because accounting is down).
  - [ ] UI (0.2.7's retry button) now reads saga progress from `payment_execution_attempts`.
- Acceptance Criteria:
  - [ ] Kill any single service at any step; the saga converges to a consistent terminal or repair state with ledger balanced. Demonstrated by the failure-injection suite (3.4.1).
- Tests: step-level idempotency replays; full failure-injection matrix.
- Definition of Done: no synchronous multi-service mutation chain remains in execution.

### Epic 3.3: Operator Repair Surface

#### Task 3.3.1: Repair queue API and UI
- Priority: P1
- Complexity: M
- Dependencies: 3.2.1, 2.2.2
- Subtasks:
  - [ ] Gateway `GET /api/repair` lists `RepairRequired` payments + dead-letter jobs with attempt history.
  - [ ] Actions: retry step, run compensation, force-complete with mandatory reason (audited).
  - [ ] UI repair view with per-attempt error detail.
- Definition of Done: every repair action produces audit events and payment_events.

### Epic 3.4: Failure Injection And Replay

#### Task 3.4.1: Failure-injection test suite
- Priority: P0
- Complexity: L
- Dependencies: 3.2.1
- Subtasks:
  - [ ] Harness that kills/hangs a named service or injects latency at a named saga step.
  - [ ] Scenarios (brief §6.17): accounting down mid-execution; reconciliation down; operations down; provider timeout; duplicate webhook (arrives with M5 — stub now); duplicate idempotency key; crash after debit before settlement.
  - [ ] Each scenario asserts: ledger balanced, no duplicate effects, payment in a documented state, repair path available.
- Definition of Done: suite runs in CI nightly; failures block release.

#### Task 3.4.2: Event replay tooling
- Priority: P2
- Complexity: M
- Dependencies: 3.1.1
- Subtasks: replay CLI (by aggregate, by time range) against inbox-protected consumers; documented in runbooks.
- Definition of Done: replaying the full event log onto a fresh read model reproduces state.

---

## Milestone 4: Identity, Tenant Isolation, And Approval Controls

Goal: controls become real — verified humans, scoped tenants, enforced four-eyes, tamper-evident audit.

### Epic 4.1: Authentication And Users

#### Task 4.1.1: User/session model + OIDC login
- Priority: P0
- Complexity: L
- Dependencies: 1.2.1
- Components: `db/migrations/identity/`, `services/api-gateway`, `apps/web`
- Subtasks:
  - [ ] `identity.users (tenant_id, email UNIQUE per tenant, display_name, status)`, `identity.sessions` (or stateless JWT — ADR-006; if cookies, CSRF tokens are mandatory, see 4.1.2).
  - [ ] OIDC integration (generic; test against a dev IdP like Keycloak in compose). SAML documented as later adapter.
  - [ ] Gateway auth middleware: every `/api/*` route except login/health requires a valid session; requests carry verified `{userId, tenantId}` context downstream.
  - [ ] Frontend: login screen, session expiry handling, user chip shows the real user — "Marta Klein" string constants deleted from gateway ([api-gateway index.mjs:51-56, 62-66, 71-76, 101-106](../services/api-gateway/src/index.mjs)), payment-service, reconciliation-service, operations-service.
- Acceptance Criteria: unauthenticated `/api/state` → 401; grep finds zero hardcoded actor names.
- Tests: authn integration tests; session expiry; token tampering.
- Definition of Done: identity context available on every request server-side.

#### Task 4.1.2: CSRF and session security
- Priority: P0 (if cookie sessions; P2 if pure bearer tokens)
- Complexity: S
- Dependencies: 4.1.1, 0.2.3 (CORS lockdown)
- Subtasks: SameSite=Strict cookies + anti-CSRF token on mutations, or Authorization-header-only; security headers (CSP, HSTS at ingress).
- Definition of Done: cross-site POST cannot mutate state (test with a hostile-origin fixture page).

### Epic 4.2: RBAC

#### Task 4.2.1: Permission model and enforcement
- Priority: P0
- Complexity: M
- Dependencies: 4.1.1
- Subtasks:
  - [ ] `roles`, `role_permissions`, `user_roles` tables; permissions exactly as brief §6.8 (`payment:create` ... `admin:manage_users`).
  - [ ] Gateway route → required-permission map; 403 with permission name on denial.
  - [ ] Seed roles: TreasuryAdmin, TreasuryOperator, Approver, ComplianceOps, Auditor(read-only), Admin.
  - [ ] UI renders controls permission-aware (hide/disable + server still enforces).
- Tests: permission matrix test — every endpoint × every seed role.
- Definition of Done: no endpoint reachable without an explicit permission entry.

### Epic 4.3: Service-To-Service Auth

#### Task 4.3.1: Internal auth
- Priority: P1
- Complexity: M
- Dependencies: 4.1.1
- Subtasks:
  - [ ] Short-lived signed service tokens (shared-secret HMAC JWT now; mTLS documented for 6.2 infra), verified by `http.mjs` middleware on every internal route.
  - [ ] Propagate acting user context in a signed header so downstream audit records the human, not just the calling service.
  - [ ] Internal endpoints (`/reset`, `/audit`, debit, evaluate) reject unauthenticated callers — the forgeable-audit hole ([operations index.mjs:37-40](../services/operations-service/src/index.mjs)) closes here.
- Definition of Done: direct unauthenticated `curl` to any internal service mutation returns 401.

### Epic 4.4: Tenant Isolation

#### Task 4.4.1: Tenant scoping and RLS
- Priority: P0 (P1 if pilot is genuinely single-tenant — decide in ADR-007, but the columns already exist)
- Complexity: L
- Dependencies: 4.1.1, all M1 schemas
- Subtasks:
  - [ ] Every query filters by `tenant_id` from verified context; enable Postgres RLS with `tenant_id = current_setting('app.tenant_id')` policies on all tables as defense in depth.
  - [ ] Connection middleware sets `app.tenant_id` per transaction.
  - [ ] Cross-tenant test suite: seed two tenants; assert every read/write path returns 404/403 across the boundary, including idempotency-key collisions across tenants.
- Definition of Done: brief §8 cross-tenant impossibility holds at API and DB layers.

### Epic 4.5: Four-Eyes Approval Enforcement

#### Task 4.5.1: Real approvals
- Priority: P0
- Complexity: M
- Dependencies: 4.1.1, 4.2.1, 1.2.3 (`payment_approvals` table already constrained)
- Subtasks:
  - [ ] Approve endpoint records `(payment_id, approver_id)`; DB UNIQUE already blocks double-approval by the same user.
  - [ ] Creator-cannot-approve rule above configurable threshold (policy field `selfApprovalAllowed` default false).
  - [ ] Approver limit: per-role max approval amount (EUR-equivalent), enforced in policy evaluation.
  - [ ] Revisit 0.2.9's ADR: zero-approval straight-through now requires the policy to explicitly enable it per tenant.
  - [ ] Approval inbox UI (list of payments awaiting *my* approval).
- Tests: creator-approves-own → 403; same-user-twice → 409 from constraint; two distinct approvers → Approved; limit-exceeded approver → 403.
- Definition of Done: brief §8 approval criteria all pass as tests.

### Epic 4.6: Audit Immutability

#### Task 4.6.1: Tamper-evident audit pipeline
- Priority: P0
- Complexity: M
- Dependencies: 4.1.1, 3.1.1 (audit flows through outbox), 1.2.4 (append-only base)
- Subtasks:
  - [ ] Audit event schema: verified actor id, tenant id, request id, action, object type/id, before/after hash (SHA-256 of canonical JSON), timestamp.
  - [ ] Hash chain: each event stores `prev_hash`; nightly job verifies the chain and alerts on break.
  - [ ] `REVOKE UPDATE, DELETE` confirmed; no application code path can modify events (the audit POST endpoint accepts internal signed callers only, per 4.3.1).
  - [ ] Audit search API (filter by actor, object, action, time range, paginated) + UI view; export (CSV/JSONL) for WORM offload — external WORM storage documented as P2 (6.5).
- Tests: chain verification detects a manually edited row in a test DB; API mutation attempts fail.
- Definition of Done: brief §8 "append-only and tamper-evident" demonstrably true.

---

## Milestone 5: Provider And Compliance Integrations

Goal: connect to real regulated rails behind adapters, with signed webhooks and real screening. Sequenced after M3 because callbacks and retries need outbox/jobs, and after M4 because credentials and webhook endpoints need auth.

### Epic 5.1: Adapter Framework And Secrets

#### Task 5.1.1: Provider adapter interface + capability model
- Priority: P1
- Complexity: M
- Dependencies: 3.1.x
- Subtasks:
  - [ ] Interface per capability: `CustodyAdapter {getBalances, submitTransfer, getTransferStatus}`, `ScreeningAdapter {screenCounterparty, screenTransaction}`, `FxAdapter {getQuote, execute}`, `BankAdapter`, `ErpAdapter {exportJournal}`.
  - [ ] `providers` table gains capabilities, environment (sandbox/prod), config ref; simulated adapter implements every interface (used by the saga since 3.2.1).
  - [ ] Circuit breaker + health polling per provider instance; provider health drives the existing policy `Provider route` check with live data.
- Definition of Done: saga runs against simulated adapters through the same interface real ones will implement.

#### Task 5.1.2: Secrets management
- Priority: P0 for any real credential; nothing real may land before this.
- Complexity: M
- Dependencies: none hard; align with 6.2 infra choice
- Subtasks: secrets provider decision (cloud secrets manager or Vault — ADR-008); runtime injection (no secrets in env files/compose); rotation procedure; secret-scanning in CI (6.4.1).
- Definition of Done: zero credentials in repo, images, or compose files; rotation runbook tested.

### Epic 5.2: First Real Integrations

#### Task 5.2.1: Custody adapter (first real rail)
- Priority: P1
- Complexity: XL
- Dependencies: 5.1.1, 5.1.2, partner selection (business input)
- Subtasks: sandbox integration; map saga step 3 to real submit/poll; provider references stored (replacing `randomHex` fakes at [payment-service index.mjs:170-171](../services/payment-service/src/index.mjs)); sandbox contract tests in CI (tagged, credentialed); balance reconciliation between custody-reported and ledger balances.
- Definition of Done: a payment settles end-to-end against the partner sandbox.

#### Task 5.2.2: AML/sanctions screening adapter
- Priority: P1
- Complexity: L
- Dependencies: 5.1.1, 1.2.4 (screening tables)
- Subtasks:
  - [ ] Replace the inline `counterparty.status` check with real `screening_requests`/`screening_results` at create and pre-execution; compliance-service's dead `POST /screen` becomes the real path or is deleted.
  - [ ] Review case lifecycle: `Review` result opens `review_cases`; approve/execute blocked until case resolved by a user with ComplianceOps permission (the 409 `review_required` path gets a resolution workflow instead of a dead end).
  - [ ] Rescreening policy (age-based) + audit of every screening decision.
- Definition of Done: no payment reaches execution without a persisted, current screening result.

#### Task 5.2.3: Webhook ingestion
- Priority: P1
- Complexity: L
- Dependencies: 3.1.1, 5.1.1
- Subtasks:
  - [ ] `platform.webhook_events (provider_id, external_id UNIQUE per provider, signature_valid, payload, received_at, processed_at)`.
  - [ ] Signature verification per provider scheme; invalid signature → store + alert + 401, never process.
  - [ ] Dedupe by external id; processing via inbox pattern; replay tool (3.4.2) covers webhooks.
  - [ ] Saga's `SettlementPending → Settled` transition driven by provider callback where supported, with polling fallback.
- Tests: duplicate webhook, out-of-order webhook, bad-signature, replay — extend 3.4.1 matrix.
- Definition of Done: brief §8 "signed, stored, deduped, replayable" holds.

### Epic 5.3: Reconciliation Engine

#### Task 5.3.1: Statement ingestion and matching
- Priority: P1
- Complexity: XL
- Dependencies: 5.2.1, 2.1.x
- Subtasks:
  - [ ] `provider_statements` ingestion (API pull and file upload); normalized statement lines.
  - [ ] Matching rules: by provider ref, then amount+date+wallet heuristics; results into `reconciliation_matches` with confidence.
  - [ ] Exception lifecycle: open → assigned → investigating → resolved(reason) | written-off(approval required); evidence notes/attachments (object storage arrives 6.2 — text notes until then).
  - [ ] Aging + SLA dashboards from timestamps.
- Tests: matched, missing-ours, missing-theirs, duplicate, amount mismatch, fee mismatch, late callback.
- Definition of Done: daily recon run produces a signed-off match report against the custody sandbox.

#### Task 5.3.2: ERP journal export
- Priority: P2
- Complexity: L
- Dependencies: 1.2.4 (export tables), 5.1.1
- Subtasks: export file generation (start CSV/SAP-friendly format), `export_batches`/`export_attempts` tracking with retry; batch immutability after export (reversals only — extends 2.x invariants); intercompany mirror entries + posting periods + FX gain/loss policy from brief §6.6 planned as three sub-deliverables here.
- Definition of Done: exported batch is immutable; re-export produces identical file (deterministic ordering).

---

## Milestone 6: Production Operations

Goal: deployable, observable, secured, recoverable.

### Epic 6.1: CI/CD

#### Task 6.1.1: CI pipeline
- Priority: P0 (CI exists from M0 informally; this formalizes gates)
- Complexity: M
- Dependencies: 0.1.1, 1.1.2
- Subtasks: pipeline stages — lint, unit, migration-check (apply from scratch), integration (test DB), contract tests, concurrency suite, build images, image scan; merge blocked on all. Nightly: failure-injection suite (3.4.1) + audit chain verification.
- Definition of Done: brief §8 "CI blocks merge on tests, lint, migration checks, security scans" true.

#### Task 6.1.2: CD and environments
- Priority: P1
- Complexity: L
- Dependencies: 6.2.1
- Subtasks: environment promotion local→dev→staging→prod; config per environment (validated at boot — env validator from brief §6.18); rolling deploy with health-gated rollout; documented rollback (previous image + migration compatibility rule: N-1 code must run against N schema).
- Definition of Done: staging deploy from merge is one action; rollback rehearsed.

### Epic 6.2: Infrastructure As Code

#### Task 6.2.1: IaC + deployment target
- Priority: P1
- Complexity: XL
- Dependencies: ADR decisions (runtime target, queue tech, managed Postgres)
- Subtasks: Terraform (or Pulumi — ADR-009); managed Postgres with PITR (completing 1.4.2); private networking — only gateway/ingress public (compose already models this); TLS ingress + WAF/rate limits; object storage for exports/evidence; queue/event-bus upgrade path for the relay if Postgres-based delivery hits limits.
- Definition of Done: staging environment fully reproducible from IaC apply.

### Epic 6.3: Observability

#### Task 6.3.1: Tracing, metrics, dashboards, alerts
- Priority: P1 (P0 for the money-path metrics)
- Complexity: L
- Dependencies: 3.x (queue depth/saga metrics exist to observe)
- Subtasks:
  - [ ] OpenTelemetry SDK in `http.mjs` + `service-client.mjs` + workers; trace context propagated end-to-end (browser request → saga job → downstream calls).
  - [ ] Metrics: payment lifecycle counts by state/reason, saga step latency/failures, outbox lag, job queue depth, DLQ size, provider latency/error rate, webhook failures, recon exception count/age, journal export failures, ledger-rebuild drift (should always be 0).
  - [ ] Log redaction middleware (no memos/names/addresses in logs) — extends 1.3.1's no-values rule.
  - [ ] Dashboards + alert rules with runbook links; SLOs: payment execution p95, gateway availability, recon completion time.
- Definition of Done: a stuck saga pages someone with a runbook link before a user notices.

### Epic 6.4: Security Engineering

#### Task 6.4.1: Scanning and hardening
- Priority: P1
- Complexity: M
- Dependencies: 6.1.1
- Subtasks: dependency scanning (now that deps exist), SAST, secrets scanning, container scanning — all merge-blocking; per-route body limits and rate limits at gateway; production security headers; threat model workshop documented (STRIDE over the M3 architecture) with mitigations tracked as issues; annual/external pentest placeholder (P2).
- Definition of Done: scan suite green in CI; threat model doc reviewed.

### Epic 6.5: DR And Runbooks

#### Task 6.5.1: Disaster recovery and operational runbooks
- Priority: P1
- Complexity: M
- Dependencies: 1.4.2, 6.2.1
- Subtasks: PITR restore drill in staging (quarterly cadence documented); runbooks: service down, DB failover, stuck saga, DLQ drain, webhook outage backfill, audit chain break, key/secret rotation; WORM/archive offload for audit + statements (completes 4.6 P2 item); retention enforcement jobs.
- Definition of Done: each runbook executed once by someone who didn't write it.

---

## Dependency Spine (critical path)

```text
0.1 tests → 0.2 fixes ─┐
                       ├→ 1.1 Postgres → 1.2 schemas (tenant_id!) → 1.3 port services
                       │                                             │
                       │                     2.1 ledger ←────────────┤
                       │                     2.2 state machine ←─────┤
                       │                     2.3 idempotency/locks ←─┘
                       │                              │
                       │                     3.1 outbox/jobs → 3.2 saga → 3.4 failure injection
                       │                                          │
4.1 identity ──────────┴──→ 4.2 RBAC → 4.5 four-eyes              │
        │                   4.3 s2s auth → 4.6 audit immutability │
        └── 4.4 tenant isolation (columns from 1.2, enforcement here)
                                                                  │
5.1 adapters+secrets → 5.2 custody/screening/webhooks ←───────────┘ → 5.3 recon engine
6.x runs alongside: 6.1 CI from M0; 6.2 IaC before first real credential (5.1.2); 6.3/6.4/6.5 before pilot go-live
```

Parallelization notes: M4 identity work (4.1–4.2) can run parallel to M2/M3 by a second engineer — it touches gateway + new identity schema, not the money path. M5 partner selection (business) should start during M2 so sandbox access exists when 5.2 begins.

## Out Of Scope (per brief §9)

Not planned here unless explicitly requested: issuing an EMT/ART, becoming a CASP, licensing strategy, full ERP product, all-chains/all-assets support, native mobile, AI features, trading/market-making, consumer wallets. The target remains a corporate treasury control plane orchestrating regulated partners.

## ADR Register Opened By This Backlog

| ADR | Decision | Due |
| --- | --- | --- |
| 001 | Dependency policy (end of zero-dep rule) | 0.1.1 |
| 002 | Straight-through processing below approval threshold | 0.2.9 |
| 003 | Postgres topology (schema-per-service) + migration tool | 1.1.1/1.1.2 |
| 004 | Schema validation library | 1.3.3 |
| 005 | Event delivery tech (Postgres relay now, bus later) | 3.1.1 |
| 006 | Session mechanism (cookie+CSRF vs bearer) | 4.1.1 |
| 007 | Single-tenant pilot vs multi-tenant enforcement timing | 4.4.1 |
| 008 | Secrets manager | 5.1.2 |
| 009 | IaC tool + runtime target | 6.2.1 |
