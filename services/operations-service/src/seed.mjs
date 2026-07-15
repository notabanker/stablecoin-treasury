import { insertAuditEventChained } from "../../../packages/shared/audit.mjs";
import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedOperations(tenantId = DEFAULT_TENANT_ID) {
  const { providers, alerts, audit } = createSeedData(tenantId);
  await withTransaction("operations", async (client) => {
    // Take the same advisory lock the audit insert path uses so the delete is
    // serialized with any concurrent inserts — no chain gaps from reset races.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [tenantId]);

    await client.query("DELETE FROM operations.providers WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM operations.alerts WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM operations.audit_events WHERE tenant_id = $1", [tenantId]);

    for (const provider of providers) {
      await client.query(
        `INSERT INTO operations.providers (id, tenant_id, name, type, jurisdiction, authority, status, latency_ms, uptime, assets, routes, incident)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          provider.id,
          tenantId,
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
        [alert.id, tenantId, alert.severity, alert.title, alert.detail, alert.status]
      );
    }
    for (const event of audit) {
      // Seed rows join the hash chain like any other event; the demo reset deletes the
      // tenant's rows above, so the chain restarts cleanly at genesis.
      await insertAuditEventChained(client, { ...event, tenantId });
    }
  }, { tenantId });
}
