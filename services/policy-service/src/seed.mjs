import { createSeedData } from "../../../packages/shared/data.mjs";
import { runWithTenant, query } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedPolicy() {
  const { policies } = createSeedData();
  // Explicit tenant context so the RLS WITH CHECK accepts the seeded tenant-1 row even
  // when reseeding runs outside a request (boot) or under a different request tenant.
  await runWithTenant(DEFAULT_TENANT_ID, () => query(
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
      DEFAULT_TENANT_ID,
      policies.approvalThreshold,
      policies.secondApprovalThreshold,
      policies.hardTransferLimit,
      policies.concentrationLimit,
      policies.allowedAssets,
      policies.allowedProviders,
      policies.requireScreening
    ]
  ));
}
