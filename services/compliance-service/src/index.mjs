import { query, runWithTenant } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { reseedCounterparties } from "./seed.mjs";

const port = Number(process.env.PORT || 4103);
const DB = "compliance";

validateProductionConfig("compliance-service");

// Top-level await: the HTTP listener (created below) must not accept traffic before the schema
// has demo data, matching the old durable-store's "seed on first boot if the file doesn't exist"
// behavior. ES modules support this at the top level, so the import itself blocks until ready.
// Bootstrap runs outside any request: enter the default-tenant RLS context explicitly
// so the seeded-data existence check does not fail closed (0 rows) and reseed every boot.
await runWithTenant(DEFAULT_TENANT_ID, bootstrap);

createJsonService({
  name: "compliance-service",
  port,
  internalAuthRequired: true,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "compliance-service" }), { public: true }),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    route("POST", "/reset", async () => {
      await reseedCounterparties();
      return ok(await listCounterparties());
    }),
    route("GET", "/counterparties", async ({ headers }) => ok(await listCounterparties(tenantIdFromHeaders(headers)))),
    route("GET", "/counterparties/:id", async ({ params, headers }) => ok(await findCounterparty(params.id, tenantIdFromHeaders(headers)))),
    route("POST", "/screen", async ({ body, headers }) => {
      const counterparty = await findCounterparty(body.counterpartyId, tenantIdFromHeaders(headers));
      return ok({
        counterpartyId: counterparty.id,
        provider: "Sentinel Chain Analytics",
        result: counterparty.status === "Approved" ? "Clear" : counterparty.status,
        risk: counterparty.risk,
        reason: counterparty.status === "Blocked" ? "Counterparty is blocked by screening policy" : "Seeded screening result"
      });
    })
  ]
});

function toApiShape(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    jurisdiction: row.jurisdiction,
    status: row.status,
    risk: row.risk,
    asset: row.asset,
    wallet: row.wallet_address
  };
}

async function listCounterparties(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    "SELECT * FROM compliance.counterparties WHERE tenant_id = $1 ORDER BY id",
    [tenantId]
  );
  return rows.map(toApiShape);
}

async function findCounterparty(id, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM compliance.counterparties WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rows[0]) {
    throw httpError(404, `counterparty ${id} not found`, "not_found");
  }
  return toApiShape(rows[0]);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM compliance.counterparties WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedCounterparties();
  }
}
