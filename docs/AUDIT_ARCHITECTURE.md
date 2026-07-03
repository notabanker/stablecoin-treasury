# Audit Architecture

## Design

Every state-change operation in payment-service emits an `audit.event_recorded` outbox event containing `{ actor, action, object, detail }`. The relay worker delivers these to `operations-service POST /audit`, which stores them in `operations.audit_events`.

## Tables

- `operations.audit_events (id, tenant_id, actor, action, object, detail, at)` — append-only (REVOKE UPDATE, DELETE)

## Outbox flow

1. Service performs a state change (create/approve/execute/cancel)
2. Within the same transaction, `appendOutboxEvents` writes one or more `audit.event_recorded` rows to `platform.outbox_events`
3. If the transaction commits, the audit event is durable
4. Relay worker polls `platform.outbox_events WHERE published_at IS NULL`, delivers via HTTP to operations-service
5. Operations-service inserts into `operations.audit_events`

## Idempotency

Relay delivers at-least-once. Operations-service does not currently deduplicate — duplicate audit rows are possible but harmless (append-only). A future inbox-based dedup would make this exactly-once.

## Current gaps

- Actor is a hardcoded string ("Marta Klein", "Policy engine") until M4 identity arrives
- No hash chain linking successive audit events (planned M4.6)
- No WORM offload (planned as P2)
- REVOKE UPDATE, DELETE protects at the DB level, but service-to-service auth is not yet enforced (calling `/audit` is unauthenticated)

## Migration path

- **M4.1**: Replace hardcoded actors with verified user IDs from session context
- **M4.3**: Require service-to-service auth on `/audit` endpoint
- **M4.6**: Implement hash chain and periodic chain verification
