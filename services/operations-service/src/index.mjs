import { createId } from "../../../packages/shared/data.mjs";
import { query } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { reseedOperations } from "./seed.mjs";

const port = Number(process.env.PORT || 4107);
const DB = "operations";

await bootstrap();

createJsonService({
  name: "operations-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "operations-service" })),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }),
    route("POST", "/reset", async () => {
      await reseedOperations();
      return ok(await listProviders());
    }),
    route("GET", "/providers", async () => ok(await listProviders())),
    route("GET", "/providers/:id", async ({ params }) => ok(await findProvider(params.id))),
    route("POST", "/providers/:id/toggle", async ({ params }) => {
      const provider = await findProvider(params.id);
      const nextStatus = provider.status === "Operational" ? "Degraded" : "Operational";
      const nextIncident = nextStatus === "Degraded" ? "Manual route degradation" : "";
      const { rows } = await query(
        DB,
        "UPDATE operations.providers SET status = $1, incident = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
        [nextStatus, nextIncident, params.id, DEFAULT_TENANT_ID]
      );
      const updated = toProviderShape(rows[0]);
      await appendAudit("Marta Klein", "Provider status changed", updated.name, updated.status);
      return ok(updated);
    }),
    route("GET", "/audit", async () => ok(await listAudit())),
    route("POST", "/audit", async ({ body }) => ok(await appendAudit(body.actor || "System", body.action, body.object, body.detail))),
    route("GET", "/alerts", async () => ok(await listAlerts())),
    route("POST", "/alerts", async ({ body }) => {
      const alert = {
        id: createId("alt"),
        severity: body.severity || "Medium",
        title: body.title,
        detail: body.detail || "",
        status: body.status || "Open"
      };
      await query(
        DB,
        "INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [alert.id, DEFAULT_TENANT_ID, alert.severity, alert.title, alert.detail, alert.status]
      );
      return ok(alert);
    }),
    route("POST", "/incidents/simulate", async () => {
      const { rows } = await query(
        DB,
        "SELECT * FROM operations.providers WHERE tenant_id = $1 AND status = 'Operational' LIMIT 1",
        [DEFAULT_TENANT_ID]
      );
      if (!rows[0]) {
        throw httpError(409, "No operational provider available to degrade", "no_provider");
      }
      const { rows: updatedRows } = await query(
        DB,
        "UPDATE operations.providers SET status = 'Degraded', incident = $1 WHERE id = $2 RETURNING *",
        ["Synthetic latency incident", rows[0].id]
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
        [alert.id, DEFAULT_TENANT_ID, alert.severity, alert.title, alert.detail, alert.status]
      );
      await appendAudit("System monitor", "Provider incident opened", provider.name, provider.incident);
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

async function listProviders() {
  const { rows } = await query(DB, "SELECT * FROM operations.providers WHERE tenant_id = $1 ORDER BY id", [DEFAULT_TENANT_ID]);
  return rows.map(toProviderShape);
}

async function findProvider(id) {
  const { rows } = await query(DB, "SELECT * FROM operations.providers WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
  if (!rows[0]) {
    throw httpError(404, `provider ${id} not found`, "not_found");
  }
  return toProviderShape(rows[0]);
}

async function listAlerts() {
  const { rows } = await query(DB, "SELECT * FROM operations.alerts WHERE tenant_id = $1 ORDER BY created_at DESC", [DEFAULT_TENANT_ID]);
  return rows.map(toAlertShape);
}

async function listAudit() {
  const { rows } = await query(DB, "SELECT * FROM operations.audit_events WHERE tenant_id = $1 ORDER BY at DESC", [DEFAULT_TENANT_ID]);
  return rows.map(toAuditShape);
}

async function appendAudit(actor, action, object, detail) {
  const event = { id: createId("aud"), at: new Date(), actor, action, object, detail: detail || "" };
  await query(
    DB,
    "INSERT INTO operations.audit_events (id, tenant_id, actor, action, object, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [event.id, DEFAULT_TENANT_ID, actor, action, object, event.detail, event.at]
  );
  return toAuditShape(event);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM operations.providers WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedOperations();
  }
}
