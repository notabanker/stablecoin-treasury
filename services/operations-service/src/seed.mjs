import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedOperations() {
  const { providers, alerts, audit } = createSeedData();
  await withTransaction("operations", async (client) => {
    await client.query("DELETE FROM operations.providers WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM operations.alerts WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM operations.audit_events WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);

    for (const provider of providers) {
      await client.query(
        `INSERT INTO operations.providers (id, tenant_id, name, type, jurisdiction, authority, status, latency_ms, uptime, assets, routes, incident)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          provider.id,
          DEFAULT_TENANT_ID,
          provider.name,
          provider.type,
          provider.jurisdiction,
          provider.authority,
          provider.status,
          provider.latencyMs,
          provider.uptime,
          provider.assets,
          provider.routes,
          provider.incident
        ]
      );
    }
    for (const alert of alerts) {
      await client.query(
        `INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [alert.id, DEFAULT_TENANT_ID, alert.severity, alert.title, alert.detail, alert.status]
      );
    }
    for (const event of audit) {
      await client.query(
        `INSERT INTO operations.audit_events (id, tenant_id, actor, action, object, detail, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.id, DEFAULT_TENANT_ID, event.actor, event.action, event.object, event.detail, event.at]
      );
    }
  });
}
