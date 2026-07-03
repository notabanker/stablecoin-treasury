export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantIdFromHeaders(headers = {}) {
  const raw = headers["x-tenant-id"] || headers["X-Tenant-Id"] || headers["x-tenant"] || "";
  const tenantId = String(raw || DEFAULT_TENANT_ID).trim();
  return UUID_RE.test(tenantId) ? tenantId : DEFAULT_TENANT_ID;
}

export function tenantHeaders(tenantId) {
  return tenantId ? { "X-Tenant-Id": tenantId } : {};
}
