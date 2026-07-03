# Database

One Postgres database, one schema per service. Every table carries `tenant_id` referencing
`identity.tenants`, even though only one tenant is seeded today (`packages/shared/tenant.mjs`
holds the constant every service uses until real auth/tenancy lands).

## Schemas

| Schema | Owns | Key tables |
| --- | --- | --- |
| `identity` | Tenants (auth/RBAC land later) | `tenants` |
| `wallet` | Entities, assets, wallets, debits | `legal_entities`, `assets`, `wallets`, `debit_operations` |
| `policy` | Thresholds, allowlists, decisions | `policies`, `policy_decisions` (append-only) |
| `compliance` | Counterparties | `counterparties` |
| `payment` | Payment lifecycle | `payments`, `payment_events` (append-only), `idempotency_keys` |
| `accounting` | Journal entries | `journal_entries` |
| `reconciliation` | Matches and exceptions | `reconciliation_rows` |
| `operations` | Providers, alerts, audit | `providers`, `alerts`, `audit_events` (append-only) |

## Invariants Enforced By The Database, Not Just The Application

- `wallet.wallets.balance >= 0` (CHECK) -- backed further by the debit endpoint's single
  `UPDATE ... WHERE balance >= $1` statement, which makes overdraft impossible under concurrency
  regardless of what the calling application code does.
- Every journal batch balances: `accounting.journal_entries` has a deferred constraint trigger
  (`assert_batch_balanced`) that sums debits/credits per `payment_id` and raises at COMMIT if
  they don't match. This is the database-level backstop for the `assertBalanced()` check the
  application already runs -- it fires even if that application check is ever bypassed.
- `payment.payments (tenant_id, reference)` is unique, backed by `payment.payment_reference_seq`
  -- concurrent payment creation cannot collide on reference numbers.
- `payment.idempotency_keys (tenant_id, idempotency_key, action)` is a primary key; reservations
  use `INSERT ... ON CONFLICT DO NOTHING`, so concurrent requests carrying the same key serialize
  through Postgres itself instead of an in-process lock.
- `accounting.journal_entries (tenant_id, payment_id, account)` and a partial unique index on
  `reconciliation.reconciliation_rows` (one `Matched` row per payment) close a real
  check-then-insert race: two concurrent calls to "create the journal batch/matched row for this
  payment if none exists" could otherwise both pass the existence check before either commits.
- `policy.policy_decisions`, `payment.payment_events`, and `operations.audit_events` are
  append-only (`REVOKE UPDATE, DELETE`).

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
via each service's `src/seed.mjs`.

## What This Is Not Yet

- No append-only double-entry ledger -- `wallet.wallets.balance` is still a mutable column
  debited in place (correctly, atomically, but not derived from immutable entries). That's the
  M2 ledger work.
- No formal payment state machine enforced by a DB-level transition table -- `payment.payments`
  constrains the status vocabulary but not the transition graph. Also M2.
- Single shared Postgres role (`notabanker` locally / one app user in Compose) rather than
  per-service roles with `REVOKE`d cross-schema access. The schema separation is real; the
  role-level enforcement described in the M1 backlog task is not yet implemented.
- No managed Postgres, PITR, or backup automation -- this is a local/Compose database only.
