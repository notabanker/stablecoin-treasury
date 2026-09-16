import { query } from "../../../packages/shared/db.mjs";
import { ok, route } from "../../../packages/shared/http.mjs";
import { createDomainService } from "../../../packages/shared/service.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { evaluate, numberOr, validatePolicy } from "./evaluate.mjs";
import { reseedPolicy } from "./seed.mjs";

const port = Number(process.env.PORT || 4102);
const DB = "policy";

await createDomainService({
  name: "policy-service",
  port,
  db: DB,
  seed: { table: "policy.policies", reseed: reseedPolicy, list: loadPolicies },
  routes: [
    route("GET", "/policies", async ({ tenantId }) => ok(await loadPolicies(tenantId))),
    route("POST", "/policies", async ({ body, tenantId }) => {
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
    route("POST", "/policies/assets/:assetId", async ({ params, body, tenantId }) => {
      const policy = await loadPolicies(tenantId);
      const allowed = new Set(policy.allowedAssets);
      body.enabled ? allowed.add(params.assetId) : allowed.delete(params.assetId);
      await query(DB, "UPDATE policy.policies SET allowed_assets = $1, updated_at = now() WHERE tenant_id = $2", [[...allowed], tenantId]);
      return ok(await loadPolicies(tenantId));
    }),
    route("POST", "/evaluate", async ({ body, tenantId }) => ok(evaluate(body, await loadPolicies(tenantId))))
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
