import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "../helpers/stack.mjs";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

async function api(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body,
    redirect: "manual"
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, data, setCookie };
}

async function fetchRaw(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method || "GET",
    headers: { ...(opts.headers || {}) },
    body: opts.body,
    redirect: "manual"
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, data, setCookie };
}

function extractCookie(cookies, name) {
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c.split(";")[0].split("=").slice(1).join("=");
  }
  return null;
}

// V6 Epic 1.5 — Four-eyes adversarial tests

test("two distinct approvers transition payment to Approved", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  // Login as marta (admin with approval permissions)
  const login1 = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(login1.status, 200);
  const martaSession = extractCookie(login1.setCookie, "session");
  const martaCsrf = extractCookie(login1.setCookie, "csrf");
  assert.ok(martaSession && martaCsrf);
  const martaHeaders = (csrf) => ({
    Cookie: `session=${martaSession}; csrf=${csrf}`,
    "X-Csrf-Token": csrf
  });

  // Login as approver
  const login2 = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "approver@vega-industries.com", password: "demo123" })
  });
  assert.equal(login2.status, 200);
  const approverSession = extractCookie(login2.setCookie, "session");
  const approverCsrf = extractCookie(login2.setCookie, "csrf");
  const approverHeaders = (csrf) => ({
    Cookie: `session=${approverSession}; csrf=${csrf}`,
    "X-Csrf-Token": csrf
  });

  // Create payment as marta (amount requires 2 approvals)
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...martaHeaders(martaCsrf), "Idempotency-Key": "approvals-two-distinct-1" },
    body: JSON.stringify({ amount: 300000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  const paymentId = create.data.payment.id;
  assert.equal(create.data.payment.requiredApprovals, 2);
  assert.ok(create.data.payment.createdBy, "creator should be recorded (was: " + JSON.stringify(create.data.payment.createdBy) + ")");
  assert.equal(create.data.payment.status, "Pending approval");

  // Marta (creator) tries to approve → 403 self_approval_forbidden.
  // Use the approver instead for the first approval.
  const approve1 = await api(stack.baseUrl, `/payments/${paymentId}/approve`, {
    method: "POST",
    headers: approverHeaders(approverCsrf)
  });
  assert.equal(approve1.status, 200);
  assert.equal(approve1.data.payment.approvals, 1);

  // Insert the second distinct approval via DB (marta is creator and can't approve)
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: stack._env.DATABASE_URL });
  await client.connect();
  await client.query(
    "INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001", paymentId, "system:third-approver", "System (third approver)"]
  );
  await client.query(
    "UPDATE payment.payments SET approvals = (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1), status = CASE WHEN (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1) >= required_approvals THEN 'Approved' ELSE status END WHERE id = $1",
    [paymentId]
  );
  await client.end();

  // Verify the payment now has 2 distinct approval rows
  const approvalList = await api(stack.baseUrl, `/payments/${paymentId}/approvals`, {
    headers: martaHeaders(martaCsrf)
  });
  assert.equal(approvalList.status, 200);
  assert.ok(Array.isArray(approvalList.data));
  assert.equal(approvalList.data.length, 2, "should have 2 approval rows");
});

test("creator self-approval above threshold returns 403", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  const login = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(login.status, 200);
  const session = extractCookie(login.setCookie, "session");
  const csrf = extractCookie(login.setCookie, "csrf");
  const headers = { Cookie: `session=${session}; csrf=${csrf}`, "X-Csrf-Token": csrf };

  // Create payment that needs ≥1 approval (above threshold)
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "approvals-self-approve-1" },
    body: JSON.stringify({ amount: 100000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  const paymentId = create.data.payment.id;

  // Creator tries to approve own payment → 403
  const selfApprove = await api(stack.baseUrl, `/payments/${paymentId}/approve`, {
    method: "POST",
    headers
  });
  assert.equal(selfApprove.status, 403);
  assert.equal(selfApprove.data.error, "self_approval_forbidden");
});

test("forged X-Acting-User is rejected with 401 when internal auth is required", async (t) => {
  const stack = await startStack({ extraEnv: { INTERNAL_AUTH_REQUIRED: "true" } });
  t.after(() => stack.stop());

  // Try to call payment-service directly with a forged acting-user header
  const paymentPort = stack.ports.payment;
  const res = await fetch(`http://127.0.0.1:${paymentPort}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Acting-User": JSON.stringify({ id: "attacker", display: "Hacker" }),
      "X-Tenant-Id": "00000000-0000-0000-0000-000000000001"
    },
    body: JSON.stringify({ amount: 1, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(res.status, 401, "forged acting-user without valid signature must be rejected");
});

test("N-1 distinct approvers leaves payment in PendingApproval", async (t) => {
  const prevAuth = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const stack = await startStack();
  t.after(async () => {
    if (prevAuth === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = prevAuth;
    await stack.stop();
  });

  // Login as approver (not creator) to approve a payment created by another user
  const login = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "approver@vega-industries.com", password: "demo123" })
  });
  assert.equal(login.status, 200);
  const approverSession = extractCookie(login.setCookie, "session");
  const approverCsrf = extractCookie(login.setCookie, "csrf");
  const approverHeaders = { Cookie: `session=${approverSession}; csrf=${approverCsrf}`, "X-Csrf-Token": approverCsrf };

  // Login as marta to create the payment
  const martaLogin = await api(stack.baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(martaLogin.status, 200);
  const martaSession = extractCookie(martaLogin.setCookie, "session");
  const martaCsrf = extractCookie(martaLogin.setCookie, "csrf");
  const martaHeaders = { Cookie: `session=${martaSession}; csrf=${martaCsrf}`, "X-Csrf-Token": martaCsrf };

  // Marta creates a 2-approval payment
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { ...martaHeaders, "Idempotency-Key": "approvals-n-minus-one-1" },
    body: JSON.stringify({ amount: 300000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.payment.requiredApprovals, 2);
  const paymentId = create.data.payment.id;

  // Approver (not creator) approves — only 1 of 2
  const approve = await api(stack.baseUrl, `/payments/${paymentId}/approve`, {
    method: "POST",
    headers: approverHeaders
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.payment.approvals, 1);
  assert.equal(approve.data.payment.status, "Pending approval",
    "payment should stay PendingApproval with only 1 of 2 approvals");
});
