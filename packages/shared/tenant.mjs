export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether missing X-Tenant-Id should 400 instead of defaulting.
 * Explicit options.required wins; otherwise TENANT_HEADER_REQUIRED=true enables it.
 */
export function isTenantHeaderRequired(options = {}) {
  if (options.required === true) return true;
  if (options.required === false) return false;
  return process.env.TENANT_HEADER_REQUIRED === "true";
}

/**
 * Resolve tenant from request headers.
 * - Missing/blank header → DEFAULT_TENANT_ID, unless required (options or TENANT_HEADER_REQUIRED)
 *   → 400 tenant_required.
 * - Present but not a UUID → 400 invalid_tenant (fail closed; never silent fallback to tenant-1).
 */
export function tenantIdFromHeaders(headers = {}, options = {}) {
  const raw = headers["x-tenant-id"] || headers["X-Tenant-Id"] || headers["x-tenant"] || "";
  const tenantId = String(raw || "").trim();
  if (!tenantId) {
    if (isTenantHeaderRequired(options)) {
      const error = new Error("X-Tenant-Id is required");
      error.status = 400;
      error.code = "tenant_required";
      throw error;
    }
    return DEFAULT_TENANT_ID;
  }
  if (!UUID_RE.test(tenantId)) {
    const error = new Error("X-Tenant-Id must be a valid UUID");
    error.status = 400;
    error.code = "invalid_tenant";
    throw error;
  }
  return tenantId;
}

export function tenantHeaders(tenantId) {
  return tenantId ? { "X-Tenant-Id": tenantId } : {};
}
