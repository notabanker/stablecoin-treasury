import { query } from "../../../packages/shared/db.mjs";
import { httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDomainService } from "../../../packages/shared/service.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { reseedCounterparties } from "./seed.mjs";

const port = Number(process.env.PORT || 4103);
const DB = "compliance";

await createDomainService({
  name: "compliance-service",
  port,
  db: DB,
  seed: { table: "compliance.counterparties", reseed: reseedCounterparties, list: listCounterparties },
  routes: [
    route("GET", "/counterparties", async ({ tenantId }) => ok(await listCounterparties(tenantId))),
    route("GET", "/counterparties/:id", async ({ params, tenantId }) => ok(await findCounterparty(params.id, tenantId))),
    route("POST", "/screen", async ({ body, tenantId }) => {
      const counterparty = await findCounterparty(body.counterpartyId, tenantId);
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
  const { rows } = await query(DB, "SELECT * FROM compliance.counterparties WHERE tenant_id = $1 ORDER BY id", [tenantId]);
  return rows.map(toApiShape);
}

async function findCounterparty(id, tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM compliance.counterparties WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (!rows[0]) {
    throw httpError(404, `counterparty ${id} not found`, "not_found");
  }
  return toApiShape(rows[0]);
}
