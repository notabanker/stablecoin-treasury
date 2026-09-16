import { query, withTransaction } from "../../../../packages/shared/db.mjs";
import { logEvent } from "../../../../packages/shared/log.mjs";
import { appendOutboxEvents } from "../../../../packages/shared/outbox.mjs";
import { withTenant } from "../../../../packages/shared/payment.mjs";
import { getActiveTenants } from "../active-tenants.mjs";

// Cancel Pending-approval payments older than 72h. The cancel and its audit outbox events share
// one transaction: an expired payment is never cancelled without a chained audit row
// (audit finding #5).
export async function expireStalePayments() {
  const tenantIds = await getActiveTenants();
  const expiredIds = [];

  for (const tenantId of tenantIds) {
    // withTransaction resolves to the callback's return value — the row array itself.
    const rows = await withTransaction("payment", async (client) => {
      const result = await client.query(
        `UPDATE payment.payments
         SET status = 'Cancelled'
         WHERE status = 'Pending approval'
           AND tenant_id = $1
           AND created_at < now() - INTERVAL '72 hours'
         RETURNING id, reference`,
        [tenantId]
      );
      if (result.rows.length > 0) {
        await appendOutboxEvents(client, withTenant(
          result.rows.map((row) => ({
            aggregateType: "payment",
            aggregateId: row.id,
            eventType: "audit.event_recorded",
            payload: { actor: "System", action: "Payment expired", object: row.reference, detail: "Auto-cancelled after 72h" }
          })),
          tenantId
        ));
      }
      return result.rows;
    });
    expiredIds.push(...rows.map((row) => row.id));
  }

  if (expiredIds.length > 0) {
    logEvent("auto_expiry", { expired: expiredIds.length, paymentIds: expiredIds });
  }
}

export async function sweepIdempotencyKeys() {
  const result = await query(
    "payment",
    `DELETE FROM payment.idempotency_keys
     WHERE status = 'done'
       AND created_at < now() - INTERVAL '48 hours'`
  );
  if (result.rowCount > 0) {
    logEvent("idempotency_sweep", { deleted: result.rowCount });
  }
}
