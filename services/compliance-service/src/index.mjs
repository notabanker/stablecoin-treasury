import { query } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { reseedCounterparties } from "./seed.mjs";

const port = Number(process.env.PORT || 4103);
const DB = "compliance";

// Top-level await: the HTTP listener (created below) must not accept traffic before the schema
// has demo data, matching the old durable-store's "seed on first boot if the file doesn't exist"
// behavior. ES modules support this at the top level, so the import itself blocks until ready.
await bootstrap();

createJsonService({
  name: "compliance-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "compliance-service" })),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }),
    route("POST", "/reset", async () => {
      await reseedCounterparties();
      return ok(await listCounterparties());
    }),
    route("GET", "/counterparties", async () => ok(await listCounterparties())),
    route("GET", "/counterparties/:id", async ({ params }) => ok(await findCounterparty(params.id))),
    route("POST", "/screen", async ({ body }) => {
      const counterparty = await findCounterparty(body.counterpartyId);
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

async function listCounterparties() {
  const { rows } = await query(
    DB,
    "SELECT * FROM compliance.counterparties WHERE tenant_id = $1 ORDER BY id",
    [DEFAULT_TENANT_ID]
  );
  return rows.map(toApiShape);
}

async function findCounterparty(id) {
  const { rows } = await query(DB, "SELECT * FROM compliance.counterparties WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
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
