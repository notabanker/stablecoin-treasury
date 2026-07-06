import { query, runWithTenant } from "../../../packages/shared/db.mjs";
import { createJsonService, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { evaluate, numberOr, validatePolicy } from "./evaluate.mjs";
import { reseedPolicy } from "./seed.mjs";

const port = Number(process.env.PORT || 4102);
const DB = "policy";

validateProductionConfig("policy-service");
// Bootstrap runs outside any request: enter the default-tenant RLS context explicitly
// so the seeded-data existence check does not fail closed (0 rows) and reseed every boot.
await runWithTenant(DEFAULT_TENANT_ID, bootstrap);

createJsonService({
  name: "policy-service",
  port,
  internalAuthRequired: true,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "policy-service" }), { public: true }),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    route("POST", "/reset", async () => {
      await reseedPolicy();
      return ok(await loadPolicies());
    }),
    route("GET", "/policies", async ({ headers }) => ok(await loadPolicies(tenantIdFromHeaders(headers)))),
    route("POST", "/policies", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      const current = await loadPolicies(tenantId);
      const next = {
        ...current,
        approvalThreshold: numberOr(current.approvalThreshold, body.approvalThreshold),
        secondApprovalThreshold: numberOr(current.secondApprovalThreshold, body.secondApprovalThreshold),
        hardTransferLimit: numberOr(current.hardTransferLimit, body.hardTransferLimit),
        concentrationLimit: numberOr(current.concentrationLimit, body.concentrationLimit)
      };
      validatePolicy(next);
      await query(
        DB,
        `UPDATE policy.policies
         SET approval_threshold = $1, second_approval_threshold = $2, hard_transfer_limit = $3, concentration_limit = $4, updated_at = now()
         WHERE tenant_id = $5`,
        [next.approvalThreshold, next.secondApprovalThreshold, next.hardTransferLimit, next.concentrationLimit, tenantId]
      );
      return ok(await loadPolicies(tenantId));
    }),
    route("POST", "/policies/assets/:assetId", async ({ params, body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      const current = await loadPolicies(tenantId);
      const allowed = new Set(current.allowedAssets);
      if (body.enabled) {
        allowed.add(params.assetId);
      } else {
        allowed.delete(params.assetId);
      }
      await query(DB, "UPDATE policy.policies SET allowed_assets = $1, updated_at = now() WHERE tenant_id = $2", [
        [...allowed],
        tenantId
      ]);
      return ok(await loadPolicies(tenantId));
    }),
    route("POST", "/evaluate", async ({ body, headers }) => ok(evaluate(body, await loadPolicies(tenantIdFromHeaders(headers)))))
  ]
});

function toApiShape(row) {
  return {
    approvalThreshold: Number(row.approval_threshold),
    secondApprovalThreshold: Number(row.second_approval_threshold),
    hardTransferLimit: Number(row.hard_transfer_limit),
    concentrationLimit: Number(row.concentration_limit),
    allowedAssets: row.allowed_assets,
    allowedProviders: row.allowed_providers,
    requireScreening: row.require_screening
  };
}

async function loadPolicies(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM policy.policies WHERE tenant_id = $1", [tenantId]);
  return toApiShape(rows[0]);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM policy.policies WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedPolicy();
  }
}
