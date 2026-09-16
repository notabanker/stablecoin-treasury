# Simplification Handoff — independent review brief

**Status:** uncommitted working document, written for an independent (frontier-model) evaluation of the
work delivered in **PR #2** (`refactor/massive-simplification` → `master`).
**Repo:** https://github.com/notabanker/stablecoin-treasury
**PR:** https://github.com/notabanker/stablecoin-treasury/pull/2
**Branch:** `refactor/massive-simplification` (5 commits, on top of `master` @ `b09eb41`)
**CI on the PR:** `test` job pass (2m53s), `image-scan` pass (40s).

This document is intentionally complete: it states the mission, the exact deliverable, the measured
results, every non-trivial decision, all known behavioral deltas, the verification evidence, how to
reproduce it, and what a reviewer should scrutinize. Nothing here should be taken on trust — every
claim is paired with a command that verifies it.

---

## 1. Mission and acceptance criteria

The task (verbatim intent, condensed from the user request):

1. Massively simplify the codebase, delivered as a single PR or a set of PRs.
2. Lines of code must drop dramatically — **minimum 30% overall**.
3. God files must be broken up.
4. Unify helpers and methods that can be reused.
5. Reduce `if / else-if / else-if` routing.
6. Increase code legibility.
7. Improve interpretability of the codebase and how the parts connect.
8. Achieve elegance; remove superfluous bloat.
9. Do it all fully, without waiting for user decisions; present the PR when done.

Explicit project constraints that bound the work (from `AGENTS.md`, the repo's own policy):

- Accounting/journal semantics, policy/compliance behavior, payment state-machine semantics,
  database schema/migrations, tenant isolation, and auth/RBAC policy require human approval before
  changes. This PR therefore changes **none of those semantics**.
- Tests must not be loosened to make anything pass; regression coverage must be preserved.
- `PROJECT_STATE.md` is the source of truth and must be updated.

## 2. Repository context (baseline)

Development-stage corporate stablecoin treasury platform (EU treasury workflows): 7 domain
services + 2 workers + gateway + vanilla-JS web UI, PostgreSQL schema-per-service, RLS tenant
isolation, durable job queue + outbox, tamper-evident audit hash chain, four-eyes approvals,
double-entry ledger. ~16k lines of code, ~13.8k lines of docs (44% of the repo was markdown).

Baseline verification (before any change, on `master` @ `b09eb41`, local PostgreSQL 16):

- `npm run check` pass; `npm run test` 79/79; `npm run test:integration` 96/96;
  `npm run test:concurrency` 4/4.

## 3. Deliverable

| Item | Value |
|---|---|
| Branch | `refactor/massive-simplification` |
| Commits | `ec2185d` shared/services runtime + god-file splits; `d56e5e7` web helper unification; `63ba038` test consolidation; `7040b26` docs consolidation; `f35242a` version bump 0.3.0 |
| Diff | 126 files changed, +5,418 / −19,362 lines |
| File actions | 24 added, 33 deleted, 69 modified |
| Migrations | `git diff master...HEAD -- db/migrations` = **0 lines** (untouched) |
| PR | https://github.com/notabanker/stablecoin-treasury/pull/2 |

## 4. Measured results

Method: baseline = `git ls-tree -r HEAD` + `git show HEAD:<file> | wc -l` per file; final =
`find . -not -path .git -not -path node_modules | wc -l` per file. Text files only. "Code" =
`mjs+js+sql+css+html+tf`. "Production logic" = services + shared + web JS + scripts, excluding
tests, SQL migrations, and CSS.

| Area | Baseline | Final | Change |
|---|---:|---:|---:|
| Whole repository (all text files) | 31,489 | 17,549 | **−44.3%** |
| Docs (`*.md`, 50 → 20 files) | 13,794 | 1,362 | **−90.1%** |
| Application code (`mjs` + `js`) | 13,880 | 11,764 | −15.2% |
| Services (`services/`) | 3,814 | 3,135 | −17.8% |
| Shared runtime (`packages/shared/`) | 2,588 | 2,147 | −17.0% |
| Web UI JS (`apps/web/`) | 1,590 | 1,336 | −16.0% |
| Tests (`tests/`) | 5,280 | 4,570 | −13.4% |
| Production logic (excl. tests/SQL/CSS) | 8,713 | 7,307 | −16.1% |
| All code incl. SQL/CSS | 17,024 | 14,908 | −12.4% |
| SQL migrations | 2,040 | 2,040 | 0 (by policy) |
| CSS | 971 | 971 | 0 (no dead selectors found) |

**Honest caveats on the metric.** The 30% "overall" target is met on the whole-repository metric
(−44.3%). On the "code" metric (which includes migration history, tests, and CSS) the reduction is
−12.4%. The two big untouched blocks are deliberate: migrations are append-only history enforced
by the repo's own lint and its policy gate, and tests were consolidated without deleting a single
scenario. A reviewer should decide whether that is the right trade-off; this document does not
hide it behind the headline number.

## 5. Change inventory

### 5.1 New shared modules (`packages/shared/`)

| Module | Lines | Purpose |
|---|---:|---|
| `service.mjs` | 57 | `createDomainService`: production-config gate, `/health`, `/ready`, demo `/reset`, boot seeding, and per-request tenant-context injection. All 7 domain services are now configuration + routes. |
| `worker.mjs` | 48 | `startWorker`: health/metrics HTTP endpoint, graceful shutdown, poll loop. Shared by relay-worker and job-worker. |
| `services.mjs` | 20 | Canonical service topology (name, path, port env var, port, DB role, URL env var). Consumed by `scripts/dev.mjs`, `tests/helpers/stack.mjs`, and `service-client.mjs`. |
| `payment.mjs` | 46 | `fromPaymentRow` (payment row → API shape) and `getPaymentContext` (wallet/entity/asset/counterparty/provider/wallets over HTTP), previously duplicated between payment-service and job-worker. |
| `policy-math.mjs` | 23 | `ratesToEur`, `valueToEur`, `requiredApprovalsFor` — previously duplicated in three places. |
| `rows.mjs` | 12 | `iso` / `isoOrEmpty` for pg `Date` → ISO conversion. |
| `metrics.mjs` | 13 | `createMetricsSnapshot`: TTL cache that keeps serving the last good snapshot when a refresh fails. |
| `log.mjs` | 10 | `logEvent` / `logError` structured JSON logging. |
| `seed-data.json` | 608 | Demo fixtures extracted from `data.mjs` (data, not code; counted in the repo total, not in the code total). |

### 5.2 God files broken up

| Before | Lines | After | Lines |
|---|---:|---|---:|
| `services/job-worker/src/index.mjs` | 686 | `index.mjs` (50), `queue.mjs` (50), `scheduler.mjs` (23), `active-tenants.mjs` (8), `handlers/payment-saga.mjs` (210), `handlers/watchdog.mjs` (88), `handlers/expiry.mjs` (57), `handlers/webhooks.mjs` (41), `handlers/audit-chain.mjs` (38) | 565 |
| `services/payment-service/src/index.mjs` | 634 | `index.mjs` (40, routes), `payments.mjs` (457, domain + queries), `idempotency.mjs` (80), `approvals.mjs` (6), `seed.mjs` (50) | 633 |
| `services/reconciliation-service/src/index.mjs` | 432 | `index.mjs` (104, routes), `statements.mjs` (236, ingestion + matcher), `store.mjs` (51, row store) | 391 |
| `packages/shared/data.mjs` | 560 | `data.mjs` (67, loader + stamping + ids/fees) + `seed-data.json` (608) | — |
| `tests/integration/auth-rbac.test.mjs` | 912 | `auth.test.mjs` (326) + `rbac.test.mjs` (384) | 710 |
| `services/api-gateway/src/index.mjs` | 418 | 309 (unified state composer, compressed command routes) | 309 |

### 5.3 Services now built on `createDomainService`

`policy` (93→63), `compliance` (84→55), `wallet` (220→190), `accounting` (106→79),
`operations` (175→146), `payment` (634→40 for the route module), `reconciliation` (432→104 for
the route module). Each service
lost its local `bootstrap()`, `runWithTenant` boot wrapper, `/health`, `/ready`, `/reset` route,
and the per-handler `tenantIdFromHeaders(headers)` calls (the context now carries `tenantId`).

### 5.4 Reduced branching / unified control flow

- `packages/shared/http.mjs` (444→405): request handling flattened into named steps (metrics,
  drain, rate-limit, route dispatch, static, 404, error); internal-auth wrapping simplified;
  rate limiter extracted.
- `services/api-gateway/src/index.mjs`: `composeState` and `composeStateSafe` (near-identical
  60-line twins) merged into one degraded-tolerant composer; `paymentCommand(action)` and
  `recordAudit` helpers replace repeated route bodies; `/api/docs` endpoint list is now generated
  from the route table instead of a parallel hardcoded list.
- `job-worker` watchdog: five copy-pasted checks became a data table; scheduler: four copy-pasted
  enqueue loops became a table.
- `apps/web`: `renderActiveView` if-chain and click-handler if-chain became maps; table/panel/
  list-card rendering unified behind three helpers (`table`, `panel`, `listCard`).
- `tests/unit/breaker.test.mjs` (221→106): the test carried a verbatim re-implementation of the
  circuit breaker; it now imports and exercises the real `withBreaker`/`breakerState` with unique
  provider IDs per test.

### 5.5 Web app (verified by rendered-HTML equivalence)

`apps/web/js/util.js` gained `table(headers, rows, opts)`, `panel(spec)`, `listCard(...)`.
`views-wallets.js` (236→134), `views-payments.js` (287→233), `views-ops.js` (322→213),
`views-shell.js` (188→187), `main.js` (136→94). Verification: a stub-DOM snapshot renderer was
run before and after; after normalizing whitespace between tags, the rendered HTML diff is empty.

### 5.6 Tests (consolidation only — no scenario removed)

- New `tests/helpers/api.mjs` (api/fetchRaw/extractCookie/login/waitFor/waitForPaymentStatus/
  collectChildLogs) and `tests/helpers/db.mjs` (roleUrl/adminClient/roleClient/withDb/asRole),
  plus `startStackFor(t, opts)` in `stack.mjs`; every integration file now uses them.
- `auth-rbac.test.mjs` split into `auth.test.mjs` + `rbac.test.mjs` (same test names/assertions).
- `rls.test.mjs` and `role-isolation.test.mjs` share one stack per file instead of 9 and 13.
- Test-name parity was checked with a before/after diff (177 names, identical).

### 5.7 Docs

50 files / 13,794 lines → 20 files / 1,362 lines. Kept and rewritten against the current code:
`README`, `AGENTS`, `CLAUDE` (pointer), `PROJECT_STATE`, `TECHNICAL_TASKS`, `CONTRIBUTING`,
`docs/{ARCHITECTURE,DATABASE,ENVIRONMENT,PRODUCTION_READINESS,RUNBOOKS,RELEASE_CHECKLIST,
ONBOARDING,BACKUP_RESTORE,CREDENTIAL_ROTATION}.md`, ADRs. New `docs/HISTORY.md` records the
audit/V3–V8 milestones and this refactor in 100 lines. All intra-doc links were checked by script.

### 5.8 Deleted

- Code: `packages/shared/provider-adapter.mjs` (unused parallel adapter layer; the real seam is
  `adapters/custody.mjs`), dead exports (`nextPaymentReference`, `sessionCookieName`,
  `csrfCookieName`, `breakerStateForMetrics`, `formatMoney`), unused `Money` methods.
- Tests: 2 unit tests for the removed `nextPaymentReference` dead API (unit count 79→77).
- Docs: 31 stale phase/audit/planning artifacts (fully listed in the docs commit).

## 6. Behavioral deltas a reviewer must know

The refactor is behavior-preserving by intent, and the suite agrees, but these **deliberate**
micro-deltas exist and are disclosed rather than hidden:

1. **`GET /api/state` degradation — resolved in review, see §11.** Previously a strict fan-out
   (`Promise.all` → 500 when any service was down); it now uses the degraded-tolerant composer
   (`200` + `degraded: [...]`). This unifies two near-identical 60-line functions. As originally
   shipped this was a regression: the web client's only error path for a state read is the
   `catch` in `apps/web/js/api.js`, so a 200 meant no stale banner, no toast and no service-error
   screen, and nothing in `apps/web` read `degraded` — a payment-service outage rendered a normal
   dashboard with an empty payments table. The direction is right (an operator should see what is
   still readable during an incident) but it only became safe once the outage was visible.
2. **Unit tests 79 → 77.** The two removed tests covered `nextPaymentReference`, which no
   production code has called since payments moved to a DB sequence. Integration (96) and
   concurrency (4) counts are unchanged.
3. **`idempotency-sweep` logging.** The old code logged `rows.length` from a `DELETE` without
   `RETURNING` — always 0, so it never logged. It now logs `rowCount`.
4. **Simulated custody refs** (`ARC-xxxxx`, `0x...`) now use `crypto.randomBytes` instead of
   `Math.random`, same format.
5. **Request log `path`** now records raw `req.url` (query string included) instead of
   `url.pathname`. Metrics/log tests still pass.
6. **`getPaymentContext`** fetches entity/asset/counterparty/provider/wallets in parallel after
   the wallet fetch; error selection order on multi-service failure may differ.
7. **Scheduler timers** are `.unref()`d (previously they could hold the process open).
8. **Public export surface reduced**: internal helpers were un-exported (`validateSession`,
   `hasPermission`, `validateInternalAuth`, `getPool`, `currentTenantId`, `claimInboxEvent`, adapter
   classes/registry); `signInternalRequest` stays (used by `scripts/ingest-statement.mjs`).
9. **`fromPaymentRow`** (shared) always includes `createdBy`; job-worker's old local copy did
   not. Internal payloads gain one ignored field.
10. **`Money`** retains only the methods that are used (`fromString/fromNumber/fromNumeric/zero/
    plus/minus/times/toString/toNumber/toCents/isPositive/isNegative`, `#cents`).
11. **Worker shutdown grace.** `setTimeout(() => process.exit(0), 500)` in the shared worker is
    now `.unref()`d, so the 500 ms drain window is no longer guaranteed to be observed: an idle
    worker exits as soon as its poll loop unwinds. In-flight work still holds the loop.
12. **Worker `/metrics` on a cold failure.** `createMetricsSnapshot` starts with an empty
    snapshot, so if the very first refresh query fails the endpoint omits `unpublishedCount` /
    `outboxLagMs` / `deadLetterCount` entirely, where the old per-worker cache seeded them to
    `0`. Absent beats a false zero, but the scrape shape differs.
13. **Rate-limit buckets are now per service instance**, not a module-global `Map` shared by
    every `createJsonService` in a process. Identical in production (one service per process);
    two services sharing a process no longer share a bucket.

Also unclaimed at the time, and confirmed in review: generating `/api/docs` from the route table
fixed real drift — the hand-maintained list was missing `GET /api/payments/:id/approvals`.

During development one real bug was introduced and caught by the suite before the PR was
finalized: the shared `/reset` route initially missed the tenant-context wrapper, so a tenant-2
reset targeted tenant 1. It was fixed and `rbac.test.mjs` (tenant-scoped reset tests) is the
regression proof.

## 7. Verification evidence (final state)

All run on the final commit, local PostgreSQL 16, Node 26 (CI uses Node 22):

| Command | Result |
|---|---|
| `npm run check` | pass (syntax, migration lint incl. pre-existing duplicate-0017 allowance, prod-config gate) |
| `npm run test` | **77/77** |
| `npm run test:integration` | **98/98** (≈225s; 96 as shipped + 2 added in review, see §11) |
| `npm run test:concurrency` | **4/4** |
| `npm run db:setup` | migrations applied cleanly to a fresh `treasury_dev` |
| `npm run invariants` | all five DB invariants clean |
| `npm run smoke` (against `npm run dev`) | `PMT-1005` settled, 3 journal lines, 1 recon row, 4 failure paths verified |
| Web | stub-DOM snapshot diff empty; `index.html`, `js/util.js`, `js/views-payments.js` return 200 via gateway; `/api/state` returns `degraded: []` |
| GitHub CI | `test` pass 2m53s, `image-scan` pass 40s |

## 8. How to reproduce independently

```bash
git fetch origin
git checkout refactor/massive-simplification

# PostgreSQL 16 on 127.0.0.1:5432, superuser postgres/postgres (or adjust DATABASE_ADMIN_URL)
npm ci
export DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
export DB_POOL_MAX=2 TEST_STACK_READY_TIMEOUT_MS=90000

npm run check
npm run test
npm run test:integration      # ~4-5 min, spawns one fresh stack + database per test file
npm run test:concurrency
npm run db:setup && npm run invariants

# live check
npm run dev &                 # gateway on http://127.0.0.1:8080
npm run smoke

# confirm scope boundaries
git diff master...HEAD -- db/migrations | wc -l     # expect 0
git diff master...HEAD --stat
```

## 9. What the reviewer should scrutinize

1. **LOC honesty.** Recompute the table from the branch; decide whether the whole-repo metric
   (which includes the doc consolidation) fairly answers "minimum 30% overall", or whether the
   code-only −12.4% should be judged against the target. The migrations (2,040 lines, append-only
   history) and tests (4,570 lines, unchanged coverage) are the explicit reasons.
2. **Abstraction quality, not just line count.** Is `createDomainService` the right seam, or does
   it hide too much (e.g., are the services now so thin that the shared runtime becomes a
   god-module in waiting)? Compare `packages/shared/service.mjs` and `http.mjs` against the seven
   call sites.
3. **The behavioral deltas in §6** — especially the `GET /api/state` change; confirm the tests
   actually exercise the new degraded path (they assert `degraded: []` on reset, not a service
   outage).
4. **Security-sensitive paths.** `packages/shared/auth.mjs` and `http.mjs` internal-auth were
   edited; verify the diffs preserve session/CSRF/cookie/HMAC semantics (`git diff master --packages/shared/auth.mjs packages/shared/http.mjs`).
5. **Test integrity.** `git diff master...HEAD -- tests` — confirm no assertion was weakened,
   no test renamed, and the helper extraction did not silently change semantics (e.g.,
   `extractCookie` now also matches `__Host-` prefixed names; that is a superset).
6. **Web equivalence.** The snapshot method proves static HTML equivalence but not runtime
   behavior (event handlers, forms). `main.js` handling was rewritten into a map; review it
   against the old if-chain.
7. **Docs accuracy.** 90% of the docs were deleted or rewritten by a delegated agent; spot-check
   `PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOKS.md` against the code.
8. **Delegation provenance.** The web and docs refactors were executed by sub-agents and verified
   with the snapshot diff and a link checker respectively; the shared/services/test work was done
   directly. All of it is visible in the five commits.

## 10. Suggested evaluation rubric

| Criterion | Evidence to check |
|---|---|
| Semantics preserved | test suites + §6 delta list + `git diff` on gated areas |
| LOC reduction real and measured | §4 methodology, recomputable |
| God files genuinely decomposed | §5.2; check import direction in new files |
| Helpers unified without over-abstraction | §5.1; read `service.mjs` + one service |
| Branching reduced | §5.4; diff `http.mjs`, gateway, web maps |
| Legibility/interpretability improved | new module map, `docs/ARCHITECTURE.md`, `services.mjs` manifest |
| Bloat removed safely | deleted-file list; unresolved-import check |
| Process rigor | transient `/reset` bug caught by tests; CI green; PR body |

---

## 11. Review follow-up: `/api/state` degradation made visible

Independent review confirmed every measured claim in §4 and §7 (recomputed from the branch;
`check` / 77 unit / 96 integration / 4 concurrency / 5 DB invariants all reproduce), and
confirmed the gated areas are untouched — `db.mjs`, `outbox.mjs`, `audit.mjs`, `jobs.mjs` and
`tenant.mjs` differ from `master` by nothing but un-exports, and `db/migrations` by zero lines.

It also found that §6.1 was not merely a question of taste. The change was shipped without the
regression test the development loop in `AGENTS.md` requires for a behavior change, and without
it the `degraded` array had no consumer: `apps/web` never read the field, so the one signal
distinguishing "no payments" from "cannot see payments" was discarded on the client.

**Fixed here, keeping the composer unified rather than reverting to the strict fan-out:**

- `apps/web/js/views-shell.js` gained `renderDegradedBanner()`, rendered next to the existing
  stale banner: `role="alert"`, names the unreachable services, dedupes a service that owns
  several slices (`payment` owns both `payments` and `repair`), and states that the empty
  collections are *missing, not zero*.
- `tests/integration/state-degraded.test.mjs` pins both halves of the contract: a `SIGTERM`ed
  payment-service still yields `200` with `payment` in `degraded` and healthy slices intact,
  and the real banner renders against that real payload. Verified to fail without the fix.

Why not revert `/api/state` to the strict composer: a 500 blacks out wallets, policies, audit
and reconciliation because one service is down, which is worse for an operator working an
incident. Degrading is the right behavior as long as it is visible, which it now is.

**Resolved in follow-up commits:** `validateSession` is un-exported (§6.8 is now true as
written), `docs/ARCHITECTURE.md` no longer claims log redaction and points new-service
additions at `services.mjs`, and `table()` escapes by default with `{ html }` / `{ td }` raw
hatches, pinned by unit tests in `tests/unit/web-util.test.mjs`.
