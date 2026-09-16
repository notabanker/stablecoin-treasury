# Database

One PostgreSQL database, one schema per service. Every tenant-scoped table carries
`tenant_id` referencing `identity.tenants` from its first migration.

## Schemas

| Schema | Owns | Key tables |
|---|---|---|
| `identity` | tenants, users, sessions, roles/permissions | `tenants`, `users`, `sessions`, `user_roles`, `role_permissions` |
| `wallet` | entities, assets, wallets, ledger | `legal_entities`, `assets`, `wallets`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, view `wallet_balances` |
| `policy` | thresholds, allowlists, decisions | `policies`, `policy_decisions` |
| `compliance` | counterparties | `counterparties` |
| `payment` | payment lifecycle | `payments`, `payment_events`, `payment_approvals`, `idempotency_keys`, `provider_submissions` |
| `accounting` | journal entries | `journal_entries`, `journal_export_batches` |
| `reconciliation` | matches, statements, exceptions | `reconciliation_rows`, `provider_statements`, `statement_lines` |
| `operations` | providers, alerts, audit | `providers`, `alerts`, `audit_events` |
| `platform` | async infrastructure | `jobs`, `outbox_events`, `inbox_events`, `webhook_events` |

## Ledger And Money Rules

- `wallet.wallets` has no balance column; balance is `SUM(credits) - SUM(debits)` per
  account, exposed by the `wallet_balances` view (`security_invoker = true`).
- Payment execution debits the source wallet (principal + fee) and credits the destination
  wallet (intra-group) or `settlement_clearing` (external), plus `fees` for the fee.
- A deferred trigger rejects any ledger transaction whose debits and credits do not net to
  zero at COMMIT; the debit path takes a row lock and checks balance in the same transaction.
- Journal batches are asserted balanced per payment at COMMIT.
- Payment status transitions are enforced by trigger; `payment_events` is the append-only log.
- Monotonic payment references come from `payment.payment_reference_seq`; reset never restarts it.

## Invariants Enforced By The Database

- No negative balance (debit check + deferred trigger).
- Balanced ledger transactions and balanced journal batches.
- Allowed payment transitions only.
- Tenant-scoped uniqueness: `(tenant_id, reference)`, `(tenant_id, idempotency_key, action)`,
  `(tenant_id, idempotency_key)` on ledger transactions, one `Matched` recon row per payment.
- Append-only tables (`REVOKE UPDATE, DELETE`): `payment_events`, `payment_approvals`,
  `policy_decisions`, ledger tables, `operations.audit_events`.

`npm run invariants` runs the live checks (negative balances, ledger imbalances, NULL-tenant
jobs/outbox, approvals integrity); all must be zero.

## Migrations

- Live in `db/migrations/NNNN_name.sql`, applied in filename order, tracked in
  `public.schema_migrations`.
- **Append-only policy: never edit or renumber an applied migration.** Add a new numbered
  file. Re-run `ls db/migrations | tail` right before creating one.
- `scripts/check-migrations.mjs` (part of `npm run check`) rejects duplicate numeric
  prefixes. Known legacy exception: two `0017_*` migrations; filenames sort alphabetically
  and history is deliberately preserved — do not renumber applied databases.

```bash
npm run db:setup   # create treasury_dev + treasury_test, apply all migrations
npm run migrate    # apply pending migrations to DATABASE_URL
```

## RLS And Roles

- Every domain service connects as its own Postgres role (`svc_wallet`, `svc_payment`, …)
  with grants limited to its own schema plus inventoried cross-schema needs. Cross-schema
  access fails with `permission denied`.
- RLS policies tenant-scope every tenant-carrying table. `packages/shared/db.mjs` sets the
  transaction-local `app.tenant_id` (AsyncLocalStorage from the request context); a missing
  context fails closed (zero rows).
- `database.schema.reset_seed(p_tenant_id)` functions are `SECURITY DEFINER` and guarded:
  calling outside the session's `app.tenant_id` context raises `reset_seed tenant mismatch`.
- Documented exceptions: `identity.*` has no RLS (tenant resolution root); `operations.providers`
  has a SELECT-only policy for the gateway (webhook tenant derivation); `platform.inbox_events`
  has no tenant column; `svc_relay`/`svc_job` carry `BYPASSRLS` for cross-tenant workers.

## Reset And Seeding

- Each service seeds its own schema on first boot if empty, and reseeds on `POST /reset`.
- Resets are **tenant-scoped to the signed caller's tenant**: Vega (tenant 1) restores the
  full demo baseline, Nordic (tenant 2) restores its baseline, unknown tenants reset empty
  and never inherit tenant-1 rows. Identity/RBAC is not reset.
- Fixtures come from `packages/shared/data.mjs` + `seed-data.json`.
- `POST /api/reset` requires `admin:reset`; in `PRODUCTION_MODE=true` it returns
  `403 demo_reset_disabled` unless `ALLOW_DEMO_RESET=true`.
- Wallet seeding posts opening-balance ledger transactions — even demo data is real
  double-entry postings.

## Known Limitations

- No intercompany receiving-entity mirror in accounting journals for intra-group transfers.
- Chain truncation (newest audit rows deleted) is not detectable without external anchoring.
