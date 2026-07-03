# Database

One Postgres database, one schema per service. Every table carries `tenant_id` referencing
`identity.tenants`, even though only one tenant is seeded today (`packages/shared/tenant.mjs`
holds the constant every service uses until real auth/tenancy lands).

## Schemas

| Schema | Owns | Key tables |
| --- | --- | --- |
| `identity` | Tenants (auth/RBAC land later) | `tenants` |
| `wallet` | Entities, assets, wallets, ledger | `legal_entities`, `assets`, `wallets`, `ledger_accounts`, `ledger_transactions` (append-only), `ledger_entries` (append-only), view `wallet_balances` |
| `policy` | Thresholds, allowlists, decisions | `policies`, `policy_decisions` (append-only) |
| `compliance` | Counterparties | `counterparties` |
| `payment` | Payment lifecycle | `payments`, `payment_events` (append-only), `idempotency_keys` |
| `accounting` | Journal entries | `journal_entries` |
| `reconciliation` | Matches and exceptions | `reconciliation_rows` |
| `operations` | Providers, alerts, audit | `providers`, `alerts`, `audit_events` (append-only) |

## The Ledger (`wallet` Schema)

`wallet.wallets` has no `balance` column. A wallet's balance is `SUM(credits) - SUM(debits)` on
its own `ledger_accounts` row, exposed as the `wallet.wallet_balances` view. Every service that
needs a wallet's balance reads this view (`wallet-service`'s own `listWallets`/`findWallet` join
against it); nothing writes a balance directly.

Sign convention: a `debit` to a `wallet`-type account decreases its balance (money leaving); a
`credit` increases it. Account types:

- `wallet` -- one per wallet, tied to `wallet_id`.
- `settlement_clearing` -- shared per asset, tenant-wide. The credit side of a debit whose money
  is leaving to an external party (a normal supplier payment).
- `fees` -- shared per asset. The credit side of the fee portion of any debit.
- `opening_balance` -- shared per asset. The contra side of seed/demo opening balances, so even
  demo data is real double-entry postings rather than a column write.

A payment execution debit posts up to three entries in one transaction: debit the source wallet
for principal+fee, credit either the **destination wallet** (if the counterparty's wallet address
resolves to another wallet this tenant owns -- an intra-group transfer) or `settlement_clearing`
(external) for the principal, and credit `fees` for the fee. Before this existed, intra-group
transfers only ever debited the source wallet with nowhere for the money to land -- the ledger
closes that gap by giving every debit a real counter-party account.

Overdraft protection: the debit route `SELECT ... FOR UPDATE`s the wallet row (a lock proxy, since
there's no longer a balance column to lock directly), reads the current balance from the view,
and only posts if sufficient -- all inside one transaction, so concurrent debits against the same
wallet serialize instead of racing.

## Payment State Transitions (`payment` Schema)

`payment.payments.status` is constrained to a vocabulary (`Pending approval`, `Approved`,
`Executing`, `Settled`, `Blocked`, `Cancelled`, `Failed`) by a CHECK constraint, and the *graph* of
allowed transitions between those statuses is enforced by a trigger
(`payment.enforce_and_log_transition`, `0012_payment_transitions.sql`): any UPDATE that changes
`status` to something not on the allowed-transitions whitelist is rejected and the triggering
statement is rolled back. Every valid transition (and the initial INSERT) is logged to the
append-only `payment.payment_events` table automatically -- no application code path can move a
payment through an invalid transition or produce a gap in its event history, because the
enforcement lives at the point of writing, not spread across every route handler that might touch
`status`.

The full formal state vocabulary from the wider engineering backlog (`Draft`, `PendingApproval`,
`SettlementPending`, `RepairRequired`, `Expired`, ...) was deliberately not adopted -- it would
rename wire-format strings the frontend and test suite depend on for no additional safety beyond
what enforcing the transition graph on the existing strings already provides. That rename remains
a possible, non-safety-critical follow-up.

## Invariants Enforced By The Database, Not Just The Application

- Wallet balances can never go negative: the debit route's balance check plus row lock happens
  inside one transaction with the ledger posting, and the deferred balance trigger below would
  catch a malformed posting even if that check were ever bypassed.
- Every ledger transaction balances: `wallet.ledger_entries` has a deferred constraint trigger
  (`assert_ledger_transaction_balanced`) that sums debits/credits per `transaction_id` and raises
  at COMMIT if they don't net to zero.
- Every accounting journal batch balances: the equivalent trigger
  (`assert_batch_balanced`) on `accounting.journal_entries`, keyed by `payment_id`.
- Payment status can only move along the allowed transition graph -- see above.
- `payment.payments (tenant_id, reference)` is unique, backed by `payment.payment_reference_seq`
  -- concurrent payment creation cannot collide on reference numbers.
- `payment.idempotency_keys (tenant_id, idempotency_key, action)` and
  `wallet.ledger_transactions (tenant_id, idempotency_key)` are unique; reservations/postings use
  `INSERT ... ON CONFLICT DO NOTHING`, so concurrent requests carrying the same key serialize
  through Postgres itself instead of an in-process lock.
- `accounting.journal_entries (tenant_id, payment_id, account)` and a partial unique index on
  `reconciliation.reconciliation_rows` (one `Matched` row per payment) close a real
  check-then-insert race found while porting: two concurrent calls to "create the journal
  batch/matched row for this payment if none exists" could otherwise both pass the existence
  check before either commits.
- `policy.policy_decisions`, `payment.payment_events`, `wallet.ledger_transactions`,
  `wallet.ledger_entries`, and `operations.audit_events` are append-only (`REVOKE UPDATE,
  DELETE`).

## Workflow

```bash
# One-time: create treasury_dev and treasury_test, apply all migrations to both.
npm run db:setup

# Apply new migrations to a specific database.
DATABASE_URL=postgres://127.0.0.1:5432/treasury_dev npm run migrate
```

Migrations live in `db/migrations/*.sql`, applied in filename order, tracked in
`public.schema_migrations`. Never edit an applied migration -- add a new numbered file.

Each service seeds its own schema on first boot if empty (mirroring the old JSON store's
"seed if the file doesn't exist" behavior) via a top-level `await bootstrap()` in its
`src/index.mjs`, and reseeds unconditionally on `POST /reset`. Seed data is generated from
`packages/shared/data.mjs`'s `createSeedData()` -- the single source of truth for demo data --
via each service's `src/seed.mjs`. Wallet seeding posts opening-balance ledger transactions
rather than writing a balance column, so demo data exercises the same posting path production
balances will use.

## What This Is Not Yet

- No accounting-side receiving-entity mirror for intercompany transfers: the ledger now correctly
  moves money between the two wallets for an intra-group payment, but the accounting journal
  batch still only books the source entity's side. That's a separate accounting-completeness gap
  from the money-movement bug the ledger fixes.
- Single shared Postgres role (`notabanker` locally / one app user in Compose) rather than
  per-service roles with `REVOKE`d cross-schema access. The schema separation is real; the
  role-level enforcement described in the M1 backlog task is not yet implemented.
- No outbox/saga around payment execution yet -- it's still a synchronous call chain across
  services (M3 backlog).
- No managed Postgres, PITR, or backup automation -- this is a local/Compose database only.
