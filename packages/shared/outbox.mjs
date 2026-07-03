import { DEFAULT_TENANT_ID } from "./tenant.mjs";

const OBOX = "platform";

// Event catalog: maps event_type to the consumer service and endpoint path the relay should
// deliver to. The relay checks this at dispatch time so misrouted events are caught there
// rather than silently posted to the wrong service.
export const EVENT_ROUTES = {
  "audit.event_recorded": { consumer: "operations", path: "/audit" },
  "reconciliation.exception_opened": { consumer: "reconciliation", path: "/reconciliation/exceptions" },
  "operations.alert_created": { consumer: "operations", path: "/alerts" }
};

// Append one or more outbox events within the caller's transaction. The client argument must be
// a pooled client from withTransaction() so these inserts share the fate of the parent state
// change: commit together, rollback together.
export async function appendOutboxEvents(client, events) {
  for (const event of events) {
    await client.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.tenantId || DEFAULT_TENANT_ID, event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)]
    );
  }
}

// Inbox guard for consumer endpoints: marks an event as consumed so at-least-once delivery from
// the relay becomes exactly-once effect. Returns true when this call should proceed with the real
// work; returns false when the event was already handled (duplicate delivery, callers should
// return 200 without repeating the side effect).
export async function claimInboxEvent(client, eventId, consumer) {
  const { rows } = await client.query(
    "INSERT INTO platform.inbox_events (event_id, consumer) VALUES ($1, $2) ON CONFLICT (event_id, consumer) DO NOTHING RETURNING event_id",
    [eventId, consumer]
  );
  return rows.length > 0;
}
