import { query } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

// Background jobs run for every tenant, not just the default one.
export async function getActiveTenants() {
  const { rows } = await query("platform", "SELECT id FROM identity.tenants WHERE status = 'active' ORDER BY created_at");
  return rows.length > 0 ? rows.map((row) => row.id) : [DEFAULT_TENANT_ID];
}
