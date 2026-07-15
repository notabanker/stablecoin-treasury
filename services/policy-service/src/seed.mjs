import { createSeedData } from "../../../packages/shared/data.mjs";
import { query } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedPolicy(tenantId = DEFAULT_TENANT_ID) {
  const { policies } = createSeedData(tenantId);
  // Explicit tenant context so the RLS WITH CHECK accepts the caller tenant's row even
  // when reseeding runs outside a request (boot) or under a different request tenant.
  // Deletes run under owner privileges via SECURITY DEFINER function (migration 0055)
  await query("policy", "SELECT policy.reset_seed($1)", [tenantId]);
  if (!policies) {
    return;
  }

  await query(
    "policy",
    `INSERT INTO policy.policies (tenant_id, approval_threshold, second_approval_threshold, hard_transfer_limit, concentration_limit, allowed_assets, allowed_providers, require_screening)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       approval_threshold = EXCLUDED.approval_threshold,
       second_approval_threshold = EXCLUDED.second_approval_threshold,
       hard_transfer_limit = EXCLUDED.hard_transfer_limit,
       concentration_limit = EXCLUDED.concentration_limit,
       allowed_assets = EXCLUDED.allowed_assets,
       allowed_providers = EXCLUDED.allowed_providers,
       require_screening = EXCLUDED.require_screening,
       updated_at = now()`,
    [
      tenantId,
      policies.approvalThreshold,
      policies.secondApprovalThreshold,
      policies.hardTransferLimit,
      policies.concentrationLimit,
      policies.allowedAssets,
      policies.allowedProviders,
      policies.requireScreening
    ]
    );
}
