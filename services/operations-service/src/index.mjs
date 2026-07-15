import { insertAuditEventChained } from "../../../packages/shared/audit.mjs";
import { createId } from "../../../packages/shared/data.mjs";
import { query, withTransaction, runWithTenant } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { withInboxDedup } from "../../../packages/shared/outbox.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { reseedOperations } from "./seed.mjs";

const port = Number(process.env.PORT || 4107);
const DB = "operations";

validateProductionConfig("operations-service");
// Bootstrap runs outside any request: enter the default-tenant RLS context explicitly
// so the seeded-data existence check does not fail closed (0 rows) and reseed every boot.
await runWithTenant(DEFAULT_TENANT_ID, bootstrap);

createJsonService({
  name: "operations-service",
  port,
  internalAuthRequired: true,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "operations-service" }), { public: true }),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    route("POST", "/reset", async ({ headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      await reseedOperations(tenantId);
      return ok(await listProviders(tenantId));
    }),
    route("GET", "/providers", async ({ headers }) => ok(await listProviders(tenantIdFromHeaders(headers)))),
    route("GET", "/providers/:id", async ({ params, headers }) => ok(await findProvider(params.id, tenantIdFromHeaders(headers)))),
    route("POST", "/providers/:id/toggle", async ({ params, body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      const provider = await findProvider(params.id, tenantId);
      const nextStatus = provider.status === "Operational" ? "Degraded" : "Operational";
      const nextIncident = nextStatus === "Degraded" ? "Manual route degradation" : "";
      const { rows } = await query(
        DB,
        "UPDATE operations.providers SET status = $1, incident = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
        [nextStatus, nextIncident, params.id, tenantId]
      );
      const updated = toProviderShape(rows[0]);
      await appendAudit(body.actor || "System", "Provider status changed", updated.name, updated.status, tenantId);
      return ok(updated);
    }),
    route("GET", "/audit", async ({ headers }) => ok(await listAudit(tenantIdFromHeaders(headers)))),
    route("POST", "/audit", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      return ok(await withInboxDedup(DB, headers, "operations", async (client) => {
        return appendAudit(body.actor || "System", body.action, body.object, body.detail, tenantId, client);
      }));
    }),
    route("GET", "/alerts", async ({ headers }) => ok(await listAlerts(tenantIdFromHeaders(headers)))),
    route("POST", "/alerts", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      const alert = {
        id: createId("alt"),
        severity: body.severity || "Medium",
        title: body.title,
        detail: body.detail || "",
        status: body.status || "Open"
      };
      return ok(await withInboxDedup(DB, headers, "operations", async (client) => insertAlert(alert, tenantId, client)));
    }),
    route("POST", "/incidents/simulate", async ({ headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
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
      await query(
        DB,
        "INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [alert.id, tenantId, alert.severity, alert.title, alert.detail, alert.status]
      );
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

async function insertAlert(alert, tenantId = DEFAULT_TENANT_ID, client = null) {
  const q = client || { query: (...args) => query(DB, ...args) };
  await q.query(
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

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM operations.providers WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedOperations();
  }
}
