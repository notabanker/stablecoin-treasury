# Backup & Restore

## pg_dump Backup

```bash
pg_dump -U postgres -h 127.0.0.1 -Fc treasury_dev > backup_$(date +%Y%m%d_%H%M%S).dump
```

For plain SQL:
```bash
pg_dump -U postgres -h 127.0.0.1 treasury_dev > backup.sql
```

## pg_restore

```bash
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE treasury_restored"
pg_restore -U postgres -h 127.0.0.1 -d treasury_restored backup.dump
# or for plain SQL:
psql -U postgres -h 127.0.0.1 treasury_restored < backup.sql
```

## Point-in-Time Recovery

PostgreSQL PITR requires WAL archiving (not configured in this prototype). For production, use cloud-managed PostgreSQL with PITR enabled.

## Migration Order

Migrations run in numeric filename order. After restoring a backup, run:
```bash
npm run migrate
```
to apply any newer migrations not included in the backup.

## Tenant Isolation

Backup includes all tenant data. When restoring to a different environment, ensure tenant isolation by:
1. Verifying tenant IDs are consistent
2. Running cross-tenant sanity checks after restore
