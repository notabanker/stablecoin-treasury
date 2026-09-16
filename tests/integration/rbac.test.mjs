import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TENANT_ID,
  TENANT_2_ID,
  api,
  bearer,
  login,
  waitForPaymentStatus
} from "../helpers/api.mjs";
import { withDb } from "../helpers/db.mjs";
import { startStackFor } from "../helpers/stack.mjs";

test("AUTH_REQUIRED gates mutating routes and enforces payment:create permission", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const anonymousCreate = await api(stack.baseUrl, "/payments", {
    method: "POST",
    body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(anonymousCreate.status, 401);

  const anonymousState = await api(stack.baseUrl, "/state");
  assert.equal(anonymousState.status, 401);

  const adminLogin = await login(stack.baseUrl, "marta@vega-industries.com");
  assert.equal(adminLogin.status, 200);
  assert.ok(adminLogin.data.session?.token);

  const adminCreate = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: {
      ...bearer(adminLogin),
      "Idempotency-Key": "auth-rbac-admin-create"
    },
    body: JSON.stringify({ amount: 101, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(adminCreate.status, 200);
  assert.ok(adminCreate.data.payment?.reference);

  const approverLogin = await login(stack.baseUrl, "approver@vega-industries.com");
  assert.equal(approverLogin.status, 200);

  const approverCreate = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: {
      ...bearer(approverLogin),
      "Idempotency-Key": "auth-rbac-approver-denied"
    },
    body: JSON.stringify({ amount: 102, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(approverCreate.status, 403);
  assert.equal(approverCreate.data.error, "forbidden");

  const approverPolicyUpdate = await api(stack.baseUrl, "/policies", {
    method: "POST",
    headers: bearer(approverLogin),
    body: JSON.stringify({})
  });
  assert.equal(approverPolicyUpdate.status, 403);
  assert.equal(approverPolicyUpdate.data.error, "forbidden");

  const approverReset = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers: bearer(approverLogin)
  });
  assert.equal(approverReset.status, 403);
  assert.equal(approverReset.data.error, "forbidden");
});

test("authenticated tenant context isolates state and supports tenant 2 payment lifecycle", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const tenant1Login = await login(stack.baseUrl, "marta@vega-industries.com");
  const tenant2Login = await login(stack.baseUrl, "admin@nordic-holdings.com");
  assert.equal(tenant1Login.status, 200);
  assert.equal(tenant2Login.status, 200);

  const tenant1Headers = bearer(tenant1Login);
  const tenant2Headers = bearer(tenant2Login);

  const tenant1State = await api(stack.baseUrl, "/state", { headers: tenant1Headers });
  const tenant2State = await api(stack.baseUrl, "/state", { headers: tenant2Headers });
  assert.equal(tenant1State.status, 200);
  assert.equal(tenant2State.status, 200);
  assert.equal(tenant1State.data.currentUser.tenantId, DEFAULT_TENANT_ID);
  assert.equal(tenant2State.data.currentUser.tenantId, TENANT_2_ID);
  assert.ok(tenant1State.data.wallets.some((wallet) => wallet.id === "wal-de-eur"));
  assert.ok(!tenant1State.data.wallets.some((wallet) => wallet.id === "wal-nordic-eur"));
  assert.ok(tenant2State.data.wallets.some((wallet) => wallet.id === "wal-nordic-eur" && wallet.balance > 0));
  assert.ok(!tenant2State.data.wallets.some((wallet) => wallet.id === "wal-de-eur"));

  const crossTenantCreate = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...tenant2Headers, "Idempotency-Key": "tenant2-cross-create" },
    body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(crossTenantCreate.status, 404);

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...tenant2Headers, "Idempotency-Key": "tenant2-create" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic-steel", sourceWalletId: "wal-nordic-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.payment.asset, "N-EURC");

  const execute = await api(stack.baseUrl, `/payments/${create.data.payment.id}/execute`, {
    method: "POST",
    headers: tenant2Headers
  });
  assert.equal(execute.status, 200);
  assert.equal(execute.data.accepted, true);

  const settled = await waitForPaymentStatus(stack.baseUrl, create.data.payment.id, "Settled", tenant2Headers);
  assert.equal(settled.status, "Settled");

  const tenant1ApproveTenant2Payment = await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, {
    method: "POST",
    headers: tenant1Headers
  });
  assert.equal(tenant1ApproveTenant2Payment.status, 404);
});

test("tenant-2 admin reset restores only the Nordic baseline and leaves tenant 1 unchanged", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const tenant1Login = await login(stack.baseUrl, "marta@vega-industries.com");
  const tenant2Login = await login(stack.baseUrl, "admin@nordic-holdings.com");
  assert.equal(tenant1Login.status, 200);
  assert.equal(tenant2Login.status, 200);

  const tenant1Headers = bearer(tenant1Login);
  const tenant2Headers = bearer(tenant2Login);

  const tenant1Before = await api(stack.baseUrl, "/state", { headers: tenant1Headers });
  assert.equal(tenant1Before.status, 200);

  const tenant2Payment = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...tenant2Headers, "Idempotency-Key": "tenant2-reset-probe" },
    body: JSON.stringify({
      amount: 1000,
      counterpartyId: "cp-nordic-steel",
      sourceWalletId: "wal-nordic-eur",
      type: "Supplier"
    })
  });
  assert.equal(tenant2Payment.status, 200);

  const readSequence = () => withDb(stack, async (client) => {
    const result = await client.query(
      "SELECT last_value, is_called FROM payment.payment_reference_seq"
    );
    return result.rows[0];
  });
  const sequenceBefore = await readSequence();

  const reset = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers: tenant2Headers,
    body: "{}"
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.deepEqual(reset.data.state.degraded, []);

  const tenant1After = await api(stack.baseUrl, "/state", { headers: tenant1Headers });
  const tenant2After = await api(stack.baseUrl, "/state", { headers: tenant2Headers });
  assert.equal(tenant1After.status, 200);
  assert.equal(tenant2After.status, 200);

  assert.deepEqual(
    tenant1After.data.payments.map((payment) => payment.id).sort(),
    tenant1Before.data.payments.map((payment) => payment.id).sort(),
    "tenant-2 reset must not delete or reseed tenant-1 payments"
  );
  assert.deepEqual(
    tenant1After.data.wallets.map((wallet) => wallet.id).sort(),
    tenant1Before.data.wallets.map((wallet) => wallet.id).sort(),
    "tenant-2 reset must not change tenant-1 wallets"
  );
  assert.deepEqual(
    tenant1After.data.providers.map((provider) => provider.id).sort(),
    tenant1Before.data.providers.map((provider) => provider.id).sort(),
    "tenant-2 reset must not change tenant-1 providers"
  );

  assert.equal(tenant2After.data.payments.length, 0);
  assert.equal(tenant2After.data.journalEntries.length, 0);
  assert.equal(tenant2After.data.reconciliation.length, 0);
  assert.deepEqual(
    tenant2After.data.wallets.map((wallet) => wallet.id).sort(),
    ["wal-nordic-eur", "wal-nordic-usd"]
  );
  assert.equal(
    tenant2After.data.wallets.find((wallet) => wallet.id === "wal-nordic-eur")?.balance,
    520000
  );
  assert.ok(tenant2After.data.counterparties.some((item) => item.id === "cp-nordic-steel"));
  assert.ok(tenant2After.data.providers.some((item) => item.id === "prov-nordic-custody"));
  assert.deepEqual(tenant2After.data.policies.allowedAssets, ["N-EURC", "N-USDC"]);

  const sequenceAfter = await readSequence();
  assert.deepEqual(
    sequenceAfter,
    sequenceBefore,
    "tenant-scoped reset must not restart the global payment-reference sequence"
  );
});

test("tenant-1 admin reset restores the Vega baseline and leaves tenant 2 unchanged", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const tenant1Login = await login(stack.baseUrl, "marta@vega-industries.com");
  const tenant2Login = await login(stack.baseUrl, "admin@nordic-holdings.com");
  assert.equal(tenant1Login.status, 200);
  assert.equal(tenant2Login.status, 200);

  const tenant1Headers = bearer(tenant1Login);
  const tenant2Headers = bearer(tenant2Login);

  const tenant2Before = await api(stack.baseUrl, "/state", { headers: tenant2Headers });
  assert.equal(tenant2Before.status, 200);

  const tenant1Payment = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...tenant1Headers, "Idempotency-Key": "tenant1-reset-probe" },
    body: JSON.stringify({
      amount: 5000,
      counterpartyId: "cp-nordic",
      sourceWalletId: "wal-de-eur",
      type: "Supplier"
    })
  });
  assert.equal(tenant1Payment.status, 200);

  const readSequence = () => withDb(stack, async (client) => {
    const result = await client.query(
      "SELECT last_value, is_called FROM payment.payment_reference_seq"
    );
    return result.rows[0];
  });
  const sequenceBefore = await readSequence();

  const reset = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers: tenant1Headers,
    body: "{}"
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.deepEqual(reset.data.state.degraded, []);

  const tenant1After = await api(stack.baseUrl, "/state", { headers: tenant1Headers });
  const tenant2After = await api(stack.baseUrl, "/state", { headers: tenant2Headers });
  assert.equal(tenant1After.status, 200);
  assert.equal(tenant2After.status, 200);

  assert.deepEqual(
    tenant1After.data.payments.map((payment) => payment.id).sort(),
    ["pay-1001", "pay-1002", "pay-1003", "pay-1004"],
    "tenant-1 reset must restore the exact Vega baseline payment set"
  );
  assert.deepEqual(
    tenant1After.data.wallets.map((wallet) => wallet.id).sort(),
    ["wal-de-eur", "wal-hold-eur", "wal-nl-usd", "wal-pl-eur"],
    "tenant-1 reset must restore the exact Vega baseline wallet set"
  );

  assert.deepEqual(
    tenant2After.data.payments.map((payment) => payment.id).sort(),
    tenant2Before.data.payments.map((payment) => payment.id).sort(),
    "tenant-1 reset must not delete or reseed tenant-2 payments"
  );
  assert.deepEqual(
    tenant2After.data.wallets.map((wallet) => wallet.id).sort(),
    tenant2Before.data.wallets.map((wallet) => wallet.id).sort(),
    "tenant-1 reset must not change tenant-2 wallets"
  );
  assert.equal(
    tenant2After.data.wallets.find((wallet) => wallet.id === "wal-nordic-eur")?.balance,
    tenant2Before.data.wallets.find((wallet) => wallet.id === "wal-nordic-eur")?.balance,
    "tenant-1 reset must not change tenant-2 wallet balances"
  );
  assert.deepEqual(
    tenant2After.data.providers.map((provider) => provider.id).sort(),
    tenant2Before.data.providers.map((provider) => provider.id).sort(),
    "tenant-1 reset must not change tenant-2 providers"
  );

  const sequenceAfter = await readSequence();
  assert.deepEqual(
    sequenceAfter,
    sequenceBefore,
    "tenant-scoped reset must not restart the global payment-reference sequence"
  );
});

test("admin:reset is granted only to each tenant's Admin role, not broadened to a platform-operator role", async (t) => {
  const stack = await startStackFor(t);

  const rows = await withDb(stack, async (client) => {
    const result = await client.query(
      `SELECT r.tenant_id, r.name AS role_name
       FROM identity.role_permissions rp
       JOIN identity.roles r ON r.id = rp.role_id
       WHERE rp.permission = 'admin:reset'
       ORDER BY r.tenant_id, r.name`
    );
    return result.rows;
  });

  // Task 0.1.3 (approved 2026-07-12): admin:reset stays on each tenant's Admin role
  // rather than moving to a new platform-operator role, because 0.1.2 made the reset
  // operation itself caller-tenant-scoped. This test is the regression backstop for
  // that decision: it fails the moment admin:reset is granted anywhere else.
  assert.deepEqual(rows, [
    { tenant_id: DEFAULT_TENANT_ID, role_name: "Admin" },
    { tenant_id: TENANT_2_ID, role_name: "Admin" }
  ]);
});

// F3 — read routes enforce payment:read; GET /api/repair requires payment:execute.
// Approved matrix (2026-08-09): payment:read on all four tenant roles (analyst, approver,
// treasury-manager, admin); repair additionally requires payment:execute (treasury-manager + admin).
test("F3: attempts/approvals require payment:read; /api/repair requires payment:execute", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const adminLogin = await login(stack.baseUrl, "marta@vega-industries.com");
  const approverLogin = await login(stack.baseUrl, "approver@vega-industries.com");
  const t2AdminLogin = await login(stack.baseUrl, "admin@nordic-holdings.com");
  const analystLogin = await login(stack.baseUrl, "maria@nordic.corp");
  assert.equal(adminLogin.status, 200);
  assert.equal(approverLogin.status, 200);
  assert.equal(t2AdminLogin.status, 200);
  assert.equal(analystLogin.status, 200);

  const adminHeaders = bearer(adminLogin);
  const approverHeaders = bearer(approverLogin);
  const t2AdminHeaders = bearer(t2AdminLogin);
  const analystHeaders = bearer(analystLogin);

  // One payment per tenant so each role reads within its own tenant.
  const t1Create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...adminHeaders, "Idempotency-Key": "f3-read-t1" },
    body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(t1Create.status, 200, JSON.stringify(t1Create.data));
  const t1PaymentId = t1Create.data.payment.id;

  const t2Create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...t2AdminHeaders, "Idempotency-Key": "f3-read-t2" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic-steel", sourceWalletId: "wal-nordic-eur", type: "Supplier" })
  });
  assert.equal(t2Create.status, 200, JSON.stringify(t2Create.data));
  const t2PaymentId = t2Create.data.payment.id;

  // payment:read → 200 for admin, approver and analyst on their own tenants' payments.
  const t1Attempts = await api(stack.baseUrl, `/payments/${t1PaymentId}/attempts`, { headers: adminHeaders });
  assert.equal(t1Attempts.status, 200);
  const t1Approvals = await api(stack.baseUrl, `/payments/${t1PaymentId}/approvals`, { headers: adminHeaders });
  assert.equal(t1Approvals.status, 200);
  const approverAttempts = await api(stack.baseUrl, `/payments/${t1PaymentId}/attempts`, { headers: approverHeaders });
  assert.equal(approverAttempts.status, 200);
  const approverApprovals = await api(stack.baseUrl, `/payments/${t1PaymentId}/approvals`, { headers: approverHeaders });
  assert.equal(approverApprovals.status, 200);
  const analystAttempts = await api(stack.baseUrl, `/payments/${t2PaymentId}/attempts`, { headers: analystHeaders });
  assert.equal(analystAttempts.status, 200);
  const analystApprovals = await api(stack.baseUrl, `/payments/${t2PaymentId}/approvals`, { headers: analystHeaders });
  assert.equal(analystApprovals.status, 200);

  // repair requires payment:execute → admin 200 (both tenants), analyst/approver 403.
  const adminRepair = await api(stack.baseUrl, "/repair", { headers: adminHeaders });
  assert.equal(adminRepair.status, 200);
  const t2AdminRepair = await api(stack.baseUrl, "/repair", { headers: t2AdminHeaders });
  assert.equal(t2AdminRepair.status, 200);
  const approverRepair = await api(stack.baseUrl, "/repair", { headers: approverHeaders });
  assert.equal(approverRepair.status, 403);
  assert.equal(approverRepair.data.error, "forbidden");
  const analystRepair = await api(stack.baseUrl, "/repair", { headers: analystHeaders });
  assert.equal(analystRepair.status, 403);
  assert.equal(analystRepair.data.error, "forbidden");
});
