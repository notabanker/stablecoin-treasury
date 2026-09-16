import { insertAuditEventChained } from "../../../packages/shared/audit.mjs";
import { createId } from "../../../packages/shared/data.mjs";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { httpError, ok, route } from "../../../packages/shared/http.mjs";
import { withInboxDedup } from "../../../packages/shared/outbox.mjs";
import { createDomainService } from "../../../packages/shared/service.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { reseedOperations } from "./seed.mjs";

const port = Number(process.env.PORT || 4107);
const DB = "operations";

await createDomainService({
  name: "operations-service",
  port,
  db: DB,
  seed: { table: "operations.providers", reseed: reseedOperations, list: listProviders },
  routes: [
    route("GET", "/providers", async ({ tenantId }) => ok(await listProviders(tenantId))),
    route("GET", "/providers/:id", async ({ params, tenantId }) => ok(await findProvider(params.id, tenantId))),
    route("POST", "/providers/:id/toggle", async ({ params, body, tenantId }) => {
      const provider = await findProvider(params.id, tenantId);
      const status = provider.status === "Operational" ? "Degraded" : "Operational";
      const incident = status === "Degraded" ? "Manual route degradation" : "";
      const { rows } = await query(
        DB,
        "UPDATE operations.providers SET status = $1, incident = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
        [status, incident, params.id, tenantId]
      );
      const updated = toProviderShape(rows[0]);
      await appendAudit(body.actor || "System", "Provider status changed", updated.name, updated.status, tenantId);
      return ok(updated);
    }),
    route("GET", "/audit", async ({ tenantId }) => ok(await listAudit(tenantId))),
    route("POST", "/audit", async ({ body, headers, tenantId }) =>
      ok(await withInboxDedup(DB, headers, "operations", (client) =>
        appendAudit(body.actor || "System", body.action, body.object, body.detail, tenantId, client)))),
    route("GET", "/alerts", async ({ tenantId }) => ok(await listAlerts(tenantId))),
    route("POST", "/alerts", async ({ body, headers, tenantId }) => {
      const alert = {
        id: createId("alt"),
        severity: body.severity || "Medium",
        title: body.title,
        detail: body.detail || "",
        status: body.status || "Open"
      };
      return ok(await withInboxDedup(DB, headers, "operations", (client) => insertAlert(alert, tenantId, client)));
    }),
    route("POST", "/incidents/simulate", async ({ tenantId }) => {
      const { rows } = await query(
        DB,
        "SELECT * FROM operations.providers WHERE tenant_id = $1 AND status = 'Operational' LIMIT 1",
        [tenantId]
      );
      if (!rows[0]) {
        throw httpError(409, "No operational provider available to degrade", "no_provider");
      }
      const { rows: updatedRows } = await query(
        DB,
        "UPDATE operations.providers SET status = 'Degraded', incident = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *",
        ["Synthetic latency incident", rows[0].id, tenantId]
      );
      const provider = toProviderShape(updatedRows[0]);
      const alert = {
        id: createId("alt"),
        severity: "Medium",
        title: `${provider.name} degraded`,
        detail: "Synthetic latency incident recorded.",
        status: "Open"
      };
      await insertAlert(alert, tenantId);
      await appendAudit("System monitor", "Provider incident opened", provider.name, provider.incident, tenantId);
      return ok({ provider, alert });
    })
  ]
});

function toProviderShape(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    jurisdiction: row.jurisdiction,
    authority: row.authority,
    status: row.status,
    latencyMs: row.latency_ms,
    uptime: Number(row.uptime),
    assets: row.assets,
    routes: row.routes,
    incident: row.incident
  };
}

function toAlertShape(row) {
  return { id: row.id, severity: row.severity, title: row.title, detail: row.detail, status: row.status };
}

function toAuditShape(row) {
  return { id: row.id, at: row.at.toISOString(), actor: row.actor, action: row.action, object: row.object, detail: row.detail };
}

async function listProviders(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM operations.providers WHERE tenant_id = $1 ORDER BY id", [tenantId]);
  return rows.map(toProviderShape);
}

async function findProvider(id, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM operations.providers WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rows[0]) {
    throw httpError(404, `provider ${id} not found`, "not_found");
  }
  return toProviderShape(rows[0]);
}

async function listAlerts(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM operations.alerts WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
  return rows.map(toAlertShape);
}

async function listAudit(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM operations.audit_events WHERE tenant_id = $1 ORDER BY at DESC", [tenantId]);
  return rows.map(toAuditShape);
}

// Insert an alert on an existing transaction client when one is given (inbox-dedup path),
// otherwise as its own statement.
async function insertAlert(alert, tenantId = DEFAULT_TENANT_ID, client = null) {
  const run = client || { query: (...args) => query(DB, ...args) };
  await run.query(
    "INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status) VALUES ($1, $2, $3, $4, $5, $6)",
    [alert.id, tenantId, alert.severity, alert.title, alert.detail, alert.status]
  );
  return alert;
}

async function appendAudit(actor, action, object, detail, tenantId = DEFAULT_TENANT_ID, client = null) {
  const event = { id: createId("aud"), at: new Date(), actor, action, object, detail: detail || "" };
  // Chain-linked insert (V6 Epic 3): must run inside a transaction so the per-tenant
  // advisory lock serializes concurrent appends.
  if (client) {
    await insertAuditEventChained(client, { ...event, tenantId });
  } else {
    await withTransaction(DB, (tx) => insertAuditEventChained(tx, { ...event, tenantId }));
  }
  return toAuditShape(event);
}
