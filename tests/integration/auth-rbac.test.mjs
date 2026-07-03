import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

async function login(baseUrl, email) {
  return api(baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "demo123" })
  });
}

test("AUTH_REQUIRED gates mutating routes and enforces payment:create permission", async (t) => {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (previousAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = previousAuthRequired;
    }
    await stack.stop();
  });

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
      Authorization: `Bearer ${adminLogin.data.session.token}`,
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
      Authorization: `Bearer ${approverLogin.data.session.token}`,
      "Idempotency-Key": "auth-rbac-approver-denied"
    },
    body: JSON.stringify({ amount: 102, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(approverCreate.status, 403);
  assert.equal(approverCreate.data.error, "forbidden");

  const approverPolicyUpdate = await api(stack.baseUrl, "/policies", {
    method: "POST",
    headers: { Authorization: `Bearer ${approverLogin.data.session.token}` },
    body: JSON.stringify({})
  });
  assert.equal(approverPolicyUpdate.status, 403);
  assert.equal(approverPolicyUpdate.data.error, "forbidden");

  const approverReset = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers: { Authorization: `Bearer ${approverLogin.data.session.token}` }
  });
  assert.equal(approverReset.status, 403);
  assert.equal(approverReset.data.error, "forbidden");
});

test("authenticated tenant context isolates state and supports tenant 2 payment lifecycle", async (t) => {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (previousAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = previousAuthRequired;
    }
    await stack.stop();
  });

  const tenant1Login = await login(stack.baseUrl, "marta@vega-industries.com");
  const tenant2Login = await login(stack.baseUrl, "admin@nordic-holdings.com");
  assert.equal(tenant1Login.status, 200);
  assert.equal(tenant2Login.status, 200);

  const tenant1Headers = { Authorization: `Bearer ${tenant1Login.data.session.token}` };
  const tenant2Headers = { Authorization: `Bearer ${tenant2Login.data.session.token}` };

  const tenant1State = await api(stack.baseUrl, "/state", { headers: tenant1Headers });
  const tenant2State = await api(stack.baseUrl, "/state", { headers: tenant2Headers });
  assert.equal(tenant1State.status, 200);
  assert.equal(tenant2State.status, 200);
  assert.equal(tenant1State.data.currentUser.tenantId, "00000000-0000-0000-0000-000000000001");
  assert.equal(tenant2State.data.currentUser.tenantId, "00000000-0000-0000-0000-000000000002");
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

  const settled = await waitForSettlement(stack.baseUrl, create.data.payment.id, tenant2Headers);
  assert.equal(settled.status, "Settled");

  const tenant1ApproveTenant2Payment = await api(stack.baseUrl, `/payments/${create.data.payment.id}/approve`, {
    method: "POST",
    headers: tenant1Headers
  });
  assert.equal(tenant1ApproveTenant2Payment.status, 404);
});

test("dev auth mode honors a supplied session tenant instead of forcing the default tenant", async (t) => {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  delete process.env.AUTH_REQUIRED;
  const stack = await startStack();
  t.after(async () => {
    if (previousAuthRequired === undefined) {
      delete process.env.AUTH_REQUIRED;
    } else {
      process.env.AUTH_REQUIRED = previousAuthRequired;
    }
    await stack.stop();
  });

  const tenant2Login = await login(stack.baseUrl, "admin@nordic-holdings.com");
  assert.equal(tenant2Login.status, 200);

  const tenant2State = await api(stack.baseUrl, "/state", {
    headers: { Authorization: `Bearer ${tenant2Login.data.session.token}` }
  });

  assert.equal(tenant2State.status, 200);
  assert.equal(tenant2State.data.currentUser.tenantId, "00000000-0000-0000-0000-000000000002");
  assert.ok(tenant2State.data.wallets.some((wallet) => wallet.id === "wal-nordic-eur" && wallet.balance > 0));
  assert.ok(!tenant2State.data.wallets.some((wallet) => wallet.id === "wal-de-eur"));
});

async function waitForSettlement(baseUrl, paymentId, headers, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api(baseUrl, "/state", { headers });
    const payment = state.data.payments.find((item) => item.id === paymentId);
    if (payment && ["Settled", "Failed", "Blocked"].includes(payment.status)) {
      return payment;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Payment ${paymentId} did not settle within ${timeoutMs}ms`);
}
