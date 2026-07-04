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

// Helper: fetch with full response object to access Set-Cookie headers
async function fetchRaw(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return { status: response.status, data, setCookie };
}

function extractCookie(setCookie, name) {
  for (const cookie of setCookie) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.split(";")[0].slice(name.length + 1);
    }
  }
  return null;
}

// GAP 1 — Logout CSRF enforcement
test("cookie-authenticated POST /api/logout without X-Csrf-Token returns 403", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const loginRes = await fetchRaw(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(loginRes.status, 200);
  const sessionCookie = extractCookie(loginRes.setCookie, "session");
  assert.ok(sessionCookie, "login should set session cookie");

  // Logout without CSRF header
  const noCsrf = await api(stack.baseUrl, "/logout", {
    method: "POST",
    headers: { Cookie: `session=${sessionCookie}` }
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error, "csrf_invalid");
});

test("cookie-authenticated POST /api/logout with correct X-Csrf-Token returns 200", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const loginRes = await fetchRaw(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  const sessionCookie = extractCookie(loginRes.setCookie, "session");
  const csrfToken = extractCookie(loginRes.setCookie, "csrf");
  assert.ok(sessionCookie && csrfToken, "login should set both cookies");

  const valid = await api(stack.baseUrl, "/logout", {
    method: "POST",
    headers: {
      Cookie: `session=${sessionCookie}; csrf=${csrfToken}`,
      "X-Csrf-Token": csrfToken
    }
  });
  assert.equal(valid.status, 200);
});

// GAP 2 — Null-CSRF session cannot mutate
test("cookie-authenticated POST /api/payments with null csrf_token returns 403", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const loginRes = await fetchRaw(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  const sessionCookie = extractCookie(loginRes.setCookie, "session");
  assert.ok(sessionCookie);

  // Null the csrf_token directly in the DB to simulate a legacy session
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: `postgres://127.0.0.1:5432/${stack.databaseName}` });
  await client.connect();
  await client.query("UPDATE identity.sessions SET csrf_token = NULL WHERE token = $1", [sessionCookie]);
  await client.end();

  const mutation = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: {
      Cookie: `session=${sessionCookie}`,
    },
    body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(mutation.status, 403);
  assert.equal(mutation.data.error, "csrf_invalid");
});

// GAP 3 — Tenant-scoped failed login audit
test("failed login for known tenant-2 email writes audit event under tenant 2", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  // Failed login for tenant-2 user (wrong password)
  await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@nordic-holdings.com", password: "wrong-password" })
  });

  // Check audit events are written under tenant 2
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: `postgres://127.0.0.1:5432/${stack.databaseName}` });
  await client.connect();
  const { rows } = await client.query(
    "SELECT * FROM operations.audit_events WHERE action = 'Login failed' AND actor LIKE $1 ORDER BY at DESC LIMIT 1",
    ['%admin@nordic-holdings.com%']
  );
  await client.end();

  assert.ok(rows[0], "failed login should create an audit event");
  assert.equal(rows[0].tenant_id, "00000000-0000-0000-0000-000000000002",
    "failed login audit should be under tenant 2, not tenant 1");
});

test("lockout for known tenant-2 email writes Login lockout audit event under tenant 2", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack({ extraEnv: { LOGIN_RATE_LIMIT_MAX: "2" } });
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const attempt = () => api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@nordic-holdings.com", password: "wrong-password" })
  });

  await attempt(); // failure 1
  await attempt(); // failure 2 → locks out
  const locked = await attempt(); // rejected by lockout → writes Login lockout audit row
  assert.equal(locked.status, 429);

  const pg = await import("pg");
  const client = new pg.Client({ connectionString: `postgres://127.0.0.1:5432/${stack.databaseName}` });
  await client.connect();
  const { rows } = await client.query(
    "SELECT * FROM operations.audit_events WHERE action = 'Login lockout' AND actor LIKE $1 ORDER BY at DESC LIMIT 1",
    ['%admin@nordic-holdings.com%']
  );
  await client.end();

  assert.ok(rows[0], "lockout should create an audit event");
  assert.equal(rows[0].tenant_id, "00000000-0000-0000-0000-000000000002",
    "lockout audit should be under tenant 2, not tenant 1");
});

test("failed login for unknown email writes audit event under the default platform tenant", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const res = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "ghost@nowhere.example", password: "wrong-password" })
  });
  assert.equal(res.status, 401, "unknown email must return the same 401 as a wrong password");

  const pg = await import("pg");
  const client = new pg.Client({ connectionString: `postgres://127.0.0.1:5432/${stack.databaseName}` });
  await client.connect();
  const { rows } = await client.query(
    "SELECT * FROM operations.audit_events WHERE action = 'Login failed' AND actor LIKE $1 ORDER BY at DESC LIMIT 1",
    ['%ghost@nowhere.example%']
  );
  await client.end();

  assert.ok(rows[0], "unknown-email failed login should create an audit event");
  assert.equal(rows[0].tenant_id, "00000000-0000-0000-0000-000000000001",
    "unknown-email failed login audit falls back to the default platform tenant");
});

// GAP 4 — Rate limiter uses trusted forwarded IP
test("rate limiter buckets differ by X-Forwarded-For when TRUST_PROXY_HEADERS=true", async (t) => {
  const prevTrust = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = "true";
  const stack = await startStack({
    extraEnv: {
      RATE_LIMIT_WINDOW_MS: "10000",
      RATE_LIMIT_MAX: "2",
      STATE_RATE_LIMIT_MAX: "2"
    }
  });
  t.after(async () => {
    if (prevTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = prevTrust;
    await stack.stop();
  });

  // Three requests from three different X-Forwarded-For IPs should not share one bucket
  const request = (fwdIp) => api(stack.baseUrl, "/docs", {
    headers: { "X-Forwarded-For": fwdIp }
  });

  const r1 = await request("192.0.2.1");
  assert.equal(r1.status, 200, "first request from IP1 should succeed");

  const r2 = await request("192.0.2.2");
  assert.equal(r2.status, 200, "second request from IP2 should succeed (different bucket)");

  const r3 = await request("192.0.2.3");
  assert.equal(r3.status, 200, "third request from IP3 should succeed (different bucket)");
});

test("rate limiter ignores X-Forwarded-For when TRUST_PROXY_HEADERS is not enabled", async (t) => {
  const stack = await startStack({
    extraEnv: {
      RATE_LIMIT_WINDOW_MS: "10000",
      RATE_LIMIT_MAX: "2"
    }
  });
  t.after(() => stack.stop());

  const request = (fwdIp) => api(stack.baseUrl, "/docs", {
    headers: { "X-Forwarded-For": fwdIp }
  });

  const r1 = await request("192.0.2.1");
  assert.equal(r1.status, 200);

  const r2 = await request("192.0.2.2");
  assert.equal(r2.status, 200);

  // Third request with spoofed IP should share the same socket-IP bucket → 429
  const r3 = await request("192.0.2.3");
  assert.equal(r3.status, 429, "spoofed X-Forwarded-For should not bypass rate limit");
  assert.equal(r3.data.error, "rate_limited");
});

// Epic 1.3 — Internal service auth enforcement: unsigned direct calls to internal
// services must return 401 when INTERNAL_AUTH_REQUIRED=true.
test("unsigned direct requests to internal services return 401 with internal auth required", async (t) => {
  const stack = await startStack({
    extraEnv: {
      INTERNAL_AUTH_REQUIRED: "true",
      INTERNAL_SERVICE_TOKEN: "test-internal-token-abc123"
    }
  });
  t.after(() => stack.stop());

  // Direct unsigned call to wallet service
  const walletUrl = `http://127.0.0.1:${stack.ports.wallet}/wallets`;
  const walletRes = await fetch(walletUrl, {
    headers: { "X-Tenant-Id": "00000000-0000-0000-0000-000000000002" }
  });
  assert.equal(walletRes.status, 401, "unsigned wallet request should be 401");
  const walletBody = await walletRes.json();
  assert.equal(walletBody.error, "internal_auth_required");

  // Direct unsigned call to payment service
  const paymentUrl = `http://127.0.0.1:${stack.ports.payment}/payments`;
  const paymentRes = await fetch(paymentUrl, {
    headers: { "X-Tenant-Id": "00000000-0000-0000-0000-000000000002" }
  });
  assert.equal(paymentRes.status, 401, "unsigned payment request should be 401");

  // Health endpoint should remain public
  const healthRes = await fetch(`http://127.0.0.1:${stack.ports.wallet}/health`);
  assert.equal(healthRes.status, 200, "health endpoint must be public");

  // Gateway-mediated request should succeed (service-client signs the request)
  const stateRes = await fetch(`${stack.baseUrl}/api/state`);
  assert.equal(stateRes.status, 200, "gateway request should succeed with signed internal calls");
});
