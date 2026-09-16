# PROJECT_STATE

Current state of truth for the stablecoin treasury platform. Update after each focused work
session; keep it factual and terse. Historical narrative lives in [docs/HISTORY.md](docs/HISTORY.md).

## Purpose And Status

Development-stage platform for EU corporate treasury workflows: hold, move, reconcile, and
report stablecoin balances through regulated partners, with policy controls, four-eyes
approvals, double-entry accounting, and a tamper-evident audit chain.

**Status: development-stage. Production money movement is NO-GO.** Settlement is simulated
behind a custody-adapter seam; real provider rails, secrets management, and production
infrastructure are not in place. Do not claim production readiness anywhere.

## Architecture In Ten Lines

1. One PostgreSQL database, one schema per service (schema-per-service).
2. `api-gateway` is the only public service: BFF, static UI, auth/RBAC, webhooks.
3. Domain services own their schema; they are reached through HMAC-signed internal HTTP.
4. `packages/shared/` holds the service/worker runtime, auth, DB/RLS, money, outbox, audit,
   jobs, metrics, and the custody adapter.
5. Payment execution is an async saga run by `job-worker` via `platform.jobs`.
6. Side effects are written transactionally to `platform.outbox_events`; `relay-worker`
   delivers them at-least-once; consumers dedupe via `platform.inbox_events`.
7. Payment status transitions are enforced by a DB trigger; ledger/journal balance is
   enforced by deferred trigger constraints at commit.
8. RLS on every tenant-scoped table plus per-service Postgres roles isolate tenants.
9. `operations.audit_events` is a per-tenant SHA-256 hash chain verified nightly.
10. The frontend is a gateway-served vanilla-JS app in `apps/web/`.

## Service Map

| Service | Port | Owns | Key modules |
|---|---|---|---|
| api-gateway | 8080 | BFF, web UI, auth/RBAC, webhooks | `src/index.mjs`, `src/webhooks.mjs` |
| wallet-service | 4101 | entities, assets, wallets, ledger | `src/ledger.mjs` |
| policy-service | 4102 | thresholds, allowlists, evaluation | `src/evaluate.mjs` |
| compliance-service | 4103 | counterparties (simulated screening) | `src/index.mjs` |
| payment-service | 4104 | payment lifecycle, approvals, idempotency | `src/payments.mjs`, `src/idempotency.mjs`, `src/approvals.mjs` |
| accounting-service | 4105 | journal entries, exports | `src/journals.mjs` |
| reconciliation-service | 4106 | matches, exceptions, statements | `src/store.mjs`, `src/statements.mjs` |
| operations-service | 4107 | providers, alerts, audit events | `src/index.mjs` |
| relay-worker | 9101 | outbox relay | `src/index.mjs` |
| job-worker | 9102 | saga, expiry, watchdog, audit chain, webhooks | `src/queue.mjs`, `src/scheduler.mjs`, `src/handlers/*` |

## Invariants With Automated Tests

| Invariant | Enforced by | Test |
|---|---|---|
| No negative wallet balance under concurrency | ledger debit + row lock + balance trigger | `payment-idempotency-db.test.mjs`, concurrency suite, `npm run invariants` |
| Ledger transactions balance (debits = credits) | deferred trigger `assert_ledger_transaction_balanced` | `payment-lifecycle.test.mjs` |
| Journal batches balance per payment | deferred trigger | `tests/unit/accounting-journals.test.mjs` |
| Payment transitions follow the allowed graph | DB trigger + `payment_events` log | `payment-transitions-db.test.mjs` |
| Four-eyes: distinct approvers, creator cannot approve | app + DB unique constraint | `approvals.test.mjs` |
| Tenant isolation (app layer) | tenant-scoped queries, cross-tenant 404 | `auth.test.mjs`, `rbac.test.mjs` |
| Tenant isolation (DB layer) | RLS fail-closed + `WITH CHECK` | `rls.test.mjs`, `role-isolation.test.mjs` |
| Audit chain tamper/relink/gap detection | SQL canonical hash chain | `audit-chain.test.mjs`, `scripts/verify-audit-chain.mjs` |
| Outbox poison events dead-letter; good events still deliver | relay DLQ + watchdog alert | `outbox-dlq.test.mjs` |
| One external transfer per payment across crash/retry | `provider_submissions` + idempotency key | `provider-crash-safety.test.mjs` |
| Wallet debit exactly once under parallel execute/retry | idempotency keys + `FOR UPDATE` | concurrency suite |
| Demo reset is tenant-scoped and prod-gated | reset functions + `ALLOW_DEMO_RESET` | `prod-reset.test.mjs`, `reset-seed-guard.test.mjs` |
| A downstream outage degrades `/api/state` visibly, never silently | gateway `degraded[]` + web degraded banner | `state-degraded.test.mjs` |

## Verification Commands

```bash
npm run check              # syntax + migration lint + prod-config gate
npm run test               # unit
npm run test:integration   # full stack against ephemeral DBs (sequential)
npm run test:concurrency   # N-way parallel money-path races
npm run test:all           # all of the above
npm run invariants         # 5 DB invariants, exit 0 when clean
npm run smoke              # live stack happy path + failure paths (resets demo data)
npm run db:setup           # create treasury_dev/treasury_test, apply migrations
npm run migrate            # apply pending migrations
npm run dev                # run all services on loopback
```

## Known Gaps / Next Work

- Money-path safety: DB backstop for creator≠approver; internal HMAC replay freshness;
  outbox DLQ replay tool; wallet-ledger idempotency request-hash check; audit insert must
  restore the caller's tenant context.
- Providers: custody execution is simulated; no sandbox rail, no real screening provider.
- Auth: OIDC/SSO is a recorded decision (ADR-011), not implemented; rate limiting is
  per-process in-memory only (ADR-010).
- Infrastructure: skeleton only — no secrets manager in use, managed Postgres/PITR, WAF,
  mTLS, centralized observability, staging, or on-call. Human-executed.
- Product: Phase 1+ work (SMB tier, sevdesk connector, onboarding, sandbox settlement) is
  parked behind approval gates and external dependencies — see [TECHNICAL_TASKS.md](TECHNICAL_TASKS.md).
