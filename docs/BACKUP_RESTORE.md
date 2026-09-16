# Backup & Restore

## Backup

Custom-format dump (recommended):

```bash
pg_dump -U postgres -h 127.0.0.1 -Fc treasury_dev > backup_$(date +%Y%m%d_%H%M%S).dump
```

Plain SQL alternative:

```bash
pg_dump -U postgres -h 127.0.0.1 treasury_dev > backup.sql
```

## Restore

```bash
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE treasury_restored"
pg_restore -U postgres -h 127.0.0.1 -d treasury_restored backup.dump
# or for plain SQL:
psql -U postgres -h 127.0.0.1 treasury_restored < backup.sql
```

After restoring:

```bash
DATABASE_URL=postgres://127.0.0.1:5432/treasury_restored npm run migrate
DATABASE_URL=... npm run invariants
DATABASE_URL=... node scripts/verify-audit-chain.mjs
```

## Point-In-Time Recovery

PITR requires WAL archiving, which is **not configured** in this local/Compose setup.
Production requires managed PostgreSQL with PITR enabled, retention policies per data class
(payments/audit: long; idempotency keys: expiring), and a restore drill.

## Notes

- Migrations are forward-only. Restore the matching backup first, then `npm run migrate`
  applies any newer migrations not present in the dump.
- A backup contains all tenants. After restoring into a different environment, verify
  tenant IDs and run the invariant and cross-tenant checks before serving traffic.
- The audit chain verifies on restored data because `row_hash`/`prev_hash` are stored rows;
  a dump that preserves all rows preserves the chain.
