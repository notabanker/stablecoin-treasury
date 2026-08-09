import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TENANT_ID,
  isTenantHeaderRequired,
  tenantIdFromHeaders,
  tenantHeaders
} from "../../packages/shared/tenant.mjs";

test("tenantIdFromHeaders defaults when header is absent", () => {
  assert.equal(tenantIdFromHeaders({}), DEFAULT_TENANT_ID);
  assert.equal(tenantIdFromHeaders({ "x-tenant-id": "" }), DEFAULT_TENANT_ID);
  assert.equal(tenantIdFromHeaders({ "x-tenant-id": "   " }), DEFAULT_TENANT_ID);
});

test("tenantIdFromHeaders with required:true rejects missing header (Q5)", () => {
  assert.throws(
    () => tenantIdFromHeaders({}, { required: true }),
    (error) => error.status === 400 && error.code === "tenant_required"
  );
  assert.throws(
    () => tenantIdFromHeaders({ "x-tenant-id": "  " }, { required: true }),
    (error) => error.code === "tenant_required"
  );
});

test("TENANT_HEADER_REQUIRED=true makes missing header fail closed (Q5)", () => {
  const previous = process.env.TENANT_HEADER_REQUIRED;
  process.env.TENANT_HEADER_REQUIRED = "true";
  try {
    assert.equal(isTenantHeaderRequired(), true);
    assert.throws(
      () => tenantIdFromHeaders({}),
      (error) => error.status === 400 && error.code === "tenant_required"
    );
    // Explicit required:false opts out even when env is on (public routes / health).
    assert.equal(tenantIdFromHeaders({}, { required: false }), DEFAULT_TENANT_ID);
    // Valid header still works under the flag.
    const id = "00000000-0000-0000-0000-000000000002";
    assert.equal(tenantIdFromHeaders({ "x-tenant-id": id }), id);
  } finally {
    if (previous === undefined) delete process.env.TENANT_HEADER_REQUIRED;
    else process.env.TENANT_HEADER_REQUIRED = previous;
  }
});

test("tenantIdFromHeaders accepts a valid UUID (any case)", () => {
  const id = "00000000-0000-0000-0000-000000000002";
  assert.equal(tenantIdFromHeaders({ "x-tenant-id": id }), id);
  assert.equal(tenantIdFromHeaders({ "X-Tenant-Id": id.toUpperCase() }), id.toUpperCase());
});

test("tenantIdFromHeaders rejects an invalid UUID instead of falling back", () => {
  assert.throws(
    () => tenantIdFromHeaders({ "x-tenant-id": "not-a-uuid" }),
    (error) => error.status === 400 && error.code === "invalid_tenant"
  );
  assert.throws(
    () => tenantIdFromHeaders({ "x-tenant-id": "00000000-0000-0000-0000-00000000000g" }),
    (error) => error.status === 400 && error.code === "invalid_tenant"
  );
  // Malformed-but-present must never silently resolve to tenant-1
  assert.throws(
    () => tenantIdFromHeaders({ "x-tenant-id": "tenant-1" }),
    (error) => error.code === "invalid_tenant" && error.status === 400
  );
});

test("tenantHeaders emits X-Tenant-Id only when provided", () => {
  assert.deepEqual(tenantHeaders("00000000-0000-0000-0000-000000000001"), {
    "X-Tenant-Id": "00000000-0000-0000-0000-000000000001"
  });
  assert.deepEqual(tenantHeaders(""), {});
  assert.deepEqual(tenantHeaders(null), {});
});
