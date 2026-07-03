# Production-Readiness & Stress Audit — Corporate Stablecoin Treasury Platform

Auditor: Fable 5 (senior staff backend / DB reliability / security / load).
Method: not just code reading — ran the app, ran all suites, ran SQL invariant checks, injected failures against a live stack, stress-tested concurrency, and empirically reproduced every serious claim. All work done against a disposable `treasury_audit` database.

---

## 1. Executive Verdict

**Raise / demo ready?** — **Yes, with caveats.** The happy path is genuinely solid: money integrity held under every stress and failure I threw at it (no negative balances, no unbalanced ledger, no double-debit, no crashes). Auth, RBAC, and tenant isolation work. It will demo well and survives investor-technical Q&A on the money-safety story.

**Production (real money movement) ready?** — **No.** Three classes of defect block it: (1) a realistic scenario leaves a payment permanently stuck in `Executing` with no working repair path; (2) the outbox's advertised exactly-once guarantee is not implemented, so the audit trail can silently duplicate; (3) production security basics are missing — unsalted SHA-256 passwords, a repo-committed webhook secret with body-derived tenant, and no rate limiting. The read path also collapses under load (28% failure at 500 concurrent state reads).

The core financial ledger is well-built. The failure-recovery and security layers around it are not yet production-grade.

---

## 2. Test Commands Run

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` | PASS | 55 files, no syntax errors |
| `npm run test` (unit) | PASS 36/36 | |
| `npm run test:integration` | 29/30 | 1 failure was environmental (stray processes from a prior session exhausted resources → readiness-poll timeout); passes clean in isolation. Not a product bug, but see F-8. |
| `npm run test:concurrency` | PASS 4/4 | |
| `auth-rbac / saga-failure / webhooks` suites | PASS 8/8 | |
| Fresh migrate from zero (`treasury_audit`) | PASS | all 24 migrations |
| Migrate re-run | PASS | idempotent no-op |
| Live smoke (manual, gateway 8080) | PASS | happy path + 4 failure paths settle correctly |
| SQL invariant checks | PASS | see §4 |
| Failure injection (accounting kill, wallet-drain, repair) | mixed | see §6 findings |
| Stress (100/100/500/50 concurrency) | mixed | see §8 |

---

## 3. Architecture Findings

**F-1 (HIGH) — Every mutation is coupled to the availability of every read service (SPOF).**
`services/api-gateway/src/index.mjs` `composeState()` (lines 163-223) fans out to 12 `serviceGet` calls and is awaited after *every* mutation (`return ok({ ...result, state: await composeState(ctx) })`).
Proof: with `accounting-service` killed, `POST /api/payments` returned **502** ("accounting request failed: fetch failed") even though the payment was created and auto-approved in `payment-service` (confirmed present in DB). The client never receives the payment id.
Impact: any single read-service outage makes all writes appear to fail. Clients retry; only idempotency keys prevent duplicate *records* (but see F-6 for the case where they don't). Availability of the write path = availability of the least-available read service.
Fix: return the mutation result immediately; compose state lazily / tolerate partial state (return what's available, mark degraded sections); or split the command response from the state projection.

**F-2 (MEDIUM) — Downstream services trust `X-Tenant-Id` blindly.**
`packages/shared/tenant.mjs` `tenantIdFromHeaders` accepts any well-formed UUID from the header. Only the gateway derives tenant from the session. Anyone able to reach ports 4101-4107 directly reads/writes any tenant. Safe *only* while services are network-isolated behind the gateway (as in compose). Document and enforce (mTLS / network policy / signed internal tokens) before any shared-network deployment.

**F-3 (LOW) — Workers are single-instance and self-terminate silently.**
`relay-worker` / `job-worker` health servers `.unref()`; the process stays alive only via the poll loop. No supervisor, no restart policy in the local stack (compose has `restart` but the loop-crash path emits no alert). A dead relay = silent halt of all audit/alert/exception delivery.

---

## 4. Database Findings

Invariant checks (live data, `treasury_audit`) — **all clean:**
- `SELECT * FROM wallet.wallet_balances WHERE balance < 0` → 0 rows (also re-checked after stress).
- Ledger debit/credit imbalance per transaction → 0 rows (also after stress).
- Cross-tenant ledger-account/wallet mismatch → 0 rows.
- `platform.jobs` / `platform.outbox_events` with NULL tenant → 0 rows.
- Tenant-scoped uniqueness verified for payments, idempotency_keys, ledger_transactions, journal_entries, reconciliation matched-once. Ledger balance trigger and journal balance trigger both enforce at COMMIT (verified rejecting `Executing→Blocked` and unbalanced batches in prior milestones).

**F-4 (MEDIUM) — `webhook_events` uniqueness is not tenant-scoped.**
`db/migrations/0022_webhooks.sql`: `UNIQUE (provider_id, external_id)`. Two tenants sharing a provider id with a colliding external id interfere — one tenant's event blocks the other's dedup (and could mask a real event). Tenant comes from the (client-controlled) body, compounding this. Fix: `UNIQUE (tenant_id, provider_id, external_id)`.

**F-5 (LOW) — Duplicate migration number `0017`.**
Both `0017_repair_retry_transition.sql` and `0017_retry_transitions.sql` exist; correct application relies on the alphabetical tiebreak (`repair` < `retry`). Renumber to keep ordering unambiguous. Fresh-migrate works today, but this is fragile.

Indexes are appropriate: `payments_tenant_status_idx`, partial `jobs_poll_idx` (pending/failed), partial `outbox_events_unpublished_idx`, `webhook_events_status_idx`. No missing index observed on the hot paths (polling, tenant filter, payment lookup).

---

## 5. Auth / RBAC / Tenant-Isolation Findings

Isolation itself **PASSED** empirically (`AUTH_REQUIRED=true`):
- Anonymous `GET /api/state` → **401**.
- Login as tenant 2 (`admin@nordic-holdings.com`) → sees only `wal-nordic-*` wallets and `cp-nordic-*` counterparties.
- Tenant 2 creating a payment from tenant-1 wallet `wal-hold-eur` → **404**. Approving a tenant-1 payment → **404**. `/api/repair` → empty. No cross-tenant write or leak found.

**F-6-SEC (HIGH) — Passwords are unsalted SHA-256.**
`packages/shared/auth.mjs` `hashPassword` = `sha256(password)`, no salt, no KDF. Proof: `sha256("demo123")` = `d3ad9315…8a791` = the exact seed hash, and **all three seed users across both tenants share the identical hash** (the migration comment claiming "per-user random hex" salt is false). Impact: instant rainbow-table cracking, trivial offline brute force, and identical hashes leak identical passwords across accounts/tenants. Unacceptable for production. Fix: argon2id / scrypt / bcrypt with per-user salt.

**F-7-SEC (MEDIUM) — Session token in `localStorage`.**
`apps/web/main.js:16` stores the bearer token in `localStorage` (XSS-readable). Escaping is consistent (see §9), so live XSS risk is low, but an httpOnly, SameSite cookie is the production-correct store. No CSRF protection exists either (would be needed if moving to cookie auth).

RBAC: permission model (`identity.role_permissions`) is seeded and enforced at the gateway via `requirePermission` for `payment:*`. Note: most non-payment mutating routes use `guard()` (auth only, no specific permission) — e.g. `policy:update`, `admin:reset`, `accounting:export` are gated by authentication but **not** by their defined permissions. The permissions exist in the DB but aren't checked on those routes. MEDIUM.

---

## 6. Payment / Saga / Repair Findings

**F-8 (CRITICAL) — Payment can be permanently stuck in `Executing` with no working repair path.**
Root cause: the saga (`services/job-worker/src/index.mjs`, policy_check step) does `UPDATE payment.payments SET status='Blocked' … status='Executing'` when the execution-time policy re-check returns Blocked. The state-machine trigger (`0017_retry_transitions.sql`) does **not** permit `Executing → Blocked`, so the UPDATE raises every time.
Reproduction (live, proven): two approved 200 000 payments from `wal-de-eur` (balance 315 000). P1 settled (balance → 114 979.60). P2's saga policy_check saw insufficient balance → attempted `Executing → Blocked` → `ERROR: Invalid payment status transition: Executing -> Blocked` → job **dead-lettered after 6 attempts** → **P2 stuck in `Executing` forever**. Money is safe (P2 never debited). `POST /api/repair/:id/retry` returns `accepted:true` (a false-positive success), re-enqueues, and the new job dead-letters identically. No API path resolves it — only manual DB surgery.
This directly violates the stated invariant "no payment stuck without repair path." The insufficient-balance trigger needs no malice — two approved payments against one wallet is ordinary.
Fix: saga must transition `Executing → Failed` (already an allowed, repairable transition) on an execution-time policy block, never `Executing → Blocked`.

**F-9 (POSITIVE) — Transient-failure resumability works correctly.**
Killed `accounting-service` mid-saga: payment stopped at `journal_creation`, wallet debited **exactly once** (idempotency key `debit:<id>` held across two retry attempts — balance dropped 30 005.10 once despite two `ledger_debit success` rows). After restoring accounting, `POST /api/repair/:id/retry` re-ran the saga to `Settled` with **one** journal batch and no second debit. This is the behavior you want, and it works.

**F-10 (MEDIUM) — Dead-letter has no proactive alert.**
In F-9, the job dead-lettered ~7 s into the outage (maxAttempts 5, exponential backoff) — before a human could react. Dead-lettered jobs emit no outbox/alert event; recovery depends on an operator watching `/api/repair`. For an outage longer than ~30 s, every in-flight payment dead-letters and waits for manual retry. Add dead-letter alerting and (optionally) an automatic re-drive with a longer ceiling.

**F-11 (POSITIVE) — Concurrency safety on execute/approve holds.** 50 concurrent executes on one payment → 1×200, 49×409, single debit. 100 concurrent same-key creates → exactly 1 payment record. `SELECT … FOR UPDATE` and the DB idempotency constraint do their job.

---

## 7. Async / Outbox / Webhook Findings

**F-12 (HIGH) — Outbox "exactly-once effect" is not implemented; side effects duplicate on redelivery.**
`packages/shared/outbox.mjs` defines `claimInboxEvent`, and `0013_outbox.sql` creates `platform.inbox_events`, but there are **zero call sites** — no consumer (`operations /audit`, `/alerts`; `reconciliation /exceptions`) checks the inbox. The relay delivers at-least-once and re-nulls `published_at` on failure; its own comment (`relay-worker/src/index.mjs:111`) claims inbox rows make this exactly-once. They don't.
Reproduction (live): delivered the same event twice to `operations /alerts` with an identical `X-Event-Id` → **2 duplicate alert rows**; `platform.inbox_events` stayed at **0 rows**. Redelivery is realistic (lost ack, `markPublished` failure, timeout-after-success). Impact: duplicated/corrupted audit trail, duplicate alerts, duplicate reconciliation exceptions — the audit-integrity story breaks under normal retry.
Fix: each consumer calls `claimInboxEvent(client, headers['x-event-id'], '<consumer>')` inside its write transaction and no-ops on duplicate.

**F-13 (MEDIUM/HIGH) — Webhook trust boundary is weak.**
`services/api-gateway/src/webhooks.mjs`: single shared secret defaults to the repo-committed `"sandbox-webhook-secret"`; the endpoint is **unauthenticated**; the tenant is taken from `body.tenantId` (client-controlled). Reproduction (live): computed an HMAC with the repo-known secret and POSTed a `transfer.settled` webhook claiming **tenant 2** → accepted (200, `signature_valid=t`, row written for tenant 2). Invalid signature correctly → 401. `verifySignature` also uses `===` (not constant-time). Today the settlement handler is a stub, so blast radius is limited — but this endpoint is designed to drive settlement/reconciliation, so fix before it does: per-provider secrets from a store, tenant derived from the authenticated provider record, constant-time compare, rate limiting.

**F-14 (POSITIVE) — Durable outbox on the write side works.** Events are inserted in the same transaction as the state change (`appendOutboxEvents`), and the integration suite confirms audit events survive an operations-service restart. The relay's premature-publish bug from a prior review is fixed (publishes only after delivery).

---

## 8. Stress Test Results

Driver: `Promise.all` load from Node against the live gateway (dev mode). Latency in ms.

| Scenario | Load | Result | Failures | p50 / p95 / p99 | Notes |
| --- | --- | --- | --- | --- | --- |
| Same idempotency key | 100 concurrent | 1×200, **99×404** | 99 spurious 404 | 253 / 265 / 437 | Exactly 1 payment created (good), but losers get **404** — see F-15 |
| Distinct idempotency keys | 100 concurrent | 100×200 | 0 | 1044 / 1114 / 1116 | 100 unique refs, correct. ~1 s latency from per-create policy eval + 12-way composeState |
| `/api/state` reads | 500 concurrent | 360×200, 12×502, **128×504** | **140 (28%)** | 13 013 / 15 017 / 15 066 | **Read path collapses.** Pool exhaustion (max 10/service) × 12-way fanout. p99 = 15 s |
| Execute one payment | 50 concurrent | 1×200, 49×409 | 0 | 490 / 498 / 545 | Single debit 20 004.20. Correct |

Post-stress invariants: 0 negative balances, 0 unbalanced ledger transactions, **no crashes / unhandled rejections / OOM** in any service log. Money integrity survived the storm.

**F-15 (HIGH) — Concurrent same-key create returns spurious 404.**
`services/payment-service/src/idempotency.mjs` `reserveIdempotencyKey` writes `status='pending'` but never branches on it: a duplicate arriving while the winner is still `pending` (payment_id NULL) hits the `else` path, reads the row, and returns `{outcome:'done', paymentId: NULL}` → `findPayment(null)` → **404**. The earlier in-process implementation had an explicit `in_progress` outcome; the DB port dropped it. Risk: a client that treats the 404 as "create failed" and retries with a **new** idempotency key creates a **second payment** (different key = different record) — a genuine duplicate-payment path. Fix: when the existing row is `pending`, return 409 `idempotency_in_progress` (client should retry same key) instead of resolving to a null payment.

**F-16 (HIGH) — No load shedding on the read path.**
No rate limiting anywhere (`grep` confirms none), no caching of `/api/state`, 12-way fanout per read, 10-connection pools. 500 concurrent reads → 28% failure at 15 s p99. Production needs rate limiting, a state cache/coalescing, larger/tuned pools, and ideally a single composed read model instead of 12 live fanouts.

---

## 9. Security Findings (consolidated)

| ID | Sev | Finding |
| --- | --- | --- |
| F-6-SEC | HIGH | Unsalted SHA-256 passwords; identical hashes across users/tenants (proven) |
| F-12 | HIGH | Audit/alert/exception duplication (inbox dedup never wired) |
| F-13 | MED/HIGH | Webhook: committed default secret, body-derived tenant, unauthenticated, non-constant-time compare |
| F-16 | HIGH | No rate limiting / load shedding anywhere |
| F-7-SEC | MED | Session token in localStorage; no CSRF strategy |
| RBAC gap | MED | `policy:update`, `admin:reset`, `accounting:export` routes gated by auth only, not their defined permissions |
| Info leak | LOW | Gateway error messages expose internal service names ("accounting request failed") |
| SQL injection | — | **CLEAN.** Only dynamic SQL is `transitionInTx` using hardcoded column names + parameterized values. All user data parameterized. |
| CORS | — | **SAFE.** Off by default; requires explicit `CORS_ORIGIN`. |
| Secrets in repo | LOW | Webhook default secret + `demo123` seed password are the only committed "secrets" (both clearly prototype) |

---

## 10. UI Findings

- **XSS: clean.** `escapeHtml` used consistently; the `detail()` and `token()` helpers escape internally; no unescaped interpolation of user-controlled fields (memo, names, audit detail) found. `innerHTML` writes use escaped values.
- **Auth flow works:** 401 → login screen; login stores token; **logout clears `state.data`** (no stale-tenant leak after logout). Tenant switch reloads `/api/state` for the new tenant.
- Repair view exists, renders metrics (queue/failed/executing/errors/retries), handles the **empty** case (`emptyState("No repairable payments")`), and the retry button calls `POST /repair/:id/retry`.
- **F-17 (LOW):** `login()` does not null `state.data` before fetching the new tenant's state — a brief stale render is possible between login success and `loadState` completing. Cosmetic.

---

## 11. Top 10 Risks (ranked)

1. **F-8** Stuck-`Executing` payment with no repair path (insufficient-balance-at-saga → illegal `Executing→Blocked`). Money-safe but operationally unrecoverable via API.
2. **F-12** Audit trail duplicates under normal retry (inbox dedup unimplemented).
3. **F-6-SEC** Unsalted SHA-256 passwords.
4. **F-16 / F-15** No rate limiting + read-path collapse; spurious 404 → client-side duplicate-payment risk.
5. **F-1** Write path fails whenever any read service is down (composeState coupling).
6. **F-13** Weak webhook trust boundary (committed secret, body tenant, unauthenticated).
7. **F-10** Dead-letter with no alert; short retry budget strands payments during outages.
8. **RBAC gap** Sensitive routes gated by auth only, not their permissions.
9. **F-4** Non-tenant-scoped webhook uniqueness.
10. **F-2** Internal services trust `X-Tenant-Id` blindly (network-isolation dependent).

---

## 12. First 15 Tasks to Fix

1. **Saga policy-block uses `Executing→Failed`, not `Executing→Blocked`.** Fix `executePaymentSaga` policy_check + balance branches; add a test that drains a wallet with two approved payments and asserts the second becomes `Failed` and is repairable.
2. **Wire inbox dedup.** In `operations` (`/audit`,`/alerts`) and `reconciliation` (`/exceptions`), call `claimInboxEvent(client, x-event-id, consumer)` in the write tx; no-op on duplicate. Test: redeliver same event id → single row.
3. **Fix concurrent same-key create.** Add `pending` → return 409 `idempotency_in_progress` in `reserveIdempotencyKey`; UI/clients retry same key. Test: 100 concurrent same key → 1×200 + 99×409, zero 404.
4. **Replace password hashing** with argon2id/scrypt + per-user salt; migrate seed users; add a login brute-force lockout/limit.
5. **Add rate limiting** at the gateway (per-IP and per-session), plus a body-size cap per route.
6. **Decouple mutations from full state compose.** Return the command result immediately; make `composeState` tolerate partial downstream outages (return available sections + `degraded` flags).
7. **Dead-letter alerting.** Emit an alert/outbox event on `dead_lettered`; surface count in `/api/repair`; consider auto re-drive with a longer ceiling.
8. **Webhook hardening.** Per-provider secrets from a store; derive tenant from the authenticated provider, not the body; constant-time signature compare; authenticate/rate-limit the endpoint; add `tenant_id` to the `webhook_events` unique key.
9. **Enforce RBAC on all mutating routes** (`policy:update`, `admin:reset`, `accounting:export`, reconciliation, operations) via `requirePermission`.
10. **Tune the read path.** Cache/coalesce `/api/state`; raise/monitor pool sizes; add a load test to CI asserting p99 under N concurrent reads.
11. **Renumber the duplicate `0017` migrations**; add a migration-lint check for unique numeric prefixes.
12. **Move session token to httpOnly+SameSite cookie**; add CSRF tokens for cookie-auth mutations.
13. **Internal service auth.** Signed internal token or mTLS so services stop trusting raw `X-Tenant-Id`; add a test that a direct call with a spoofed tenant header is rejected.
14. **Redact internal service names** from gateway-returned error messages; keep detail server-side/logged.
15. **Supervisor + restart + health alerting for workers**; run ≥2 relay/job instances and add a test that a killed relay is replaced and no event is lost.

---

## 13. Final Go / No-Go

- **Demo ready:** **GO.** Happy path is clean, money integrity is real, isolation works, UI is polished and safe. Avoid the failure demos (kill-a-service, drain-a-wallet).
- **Investor diligence ready:** **CONDITIONAL GO.** The ledger/state-machine/idempotency story stands up to scrutiny and the code shows real engineering discipline. A thorough technical diligence *will* surface F-8, F-12, and unsalted passwords — have this report and a remediation plan in hand so they read as "known and scheduled," not "discovered."
- **Production money-movement ready:** **NO-GO.** Blockers, in order: F-8 (unrecoverable stuck payments), F-12 (audit duplication), F-6-SEC (password hashing), F-16/F-15 (no load shedding + duplicate-payment 404 path), F-1 (write availability coupled to reads), F-13 (webhook trust). None are architectural rewrites — the ledger foundation is sound — but all are must-fix before real funds move. Estimate: the 15 tasks above are a focused 2–4 week hardening pass for one experienced engineer, after which a re-audit (especially re-running the F-8 drain scenario, the F-12 redelivery test, and the 500-read stress) is warranted.
