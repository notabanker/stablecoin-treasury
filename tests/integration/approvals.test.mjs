import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TENANT_ID, api, extractCookie, login } from "../helpers/api.mjs";
import { withDb } from "../helpers/db.mjs";
import { startStackFor } from "../helpers/stack.mjs";

// V6 Epic 1.5 — Four-eyes adversarial tests

test("two distinct approvers transition payment to Approved", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  // Login as marta (admin with approval permissions)
  const login1 = await login(stack.baseUrl, "marta@vega-industries.com");
  assert.equal(login1.status, 200);
  const martaSession = extractCookie(login1.setCookie, "session");
  const martaCsrf = extractCookie(login1.setCookie, "csrf");
  assert.ok(martaSession && martaCsrf);
  const martaHeaders = (csrf) => ({
    Cookie: `session=${martaSession}; csrf=${csrf}`,
    "X-Csrf-Token": csrf
  });

  // Login as approver
  const login2 = await login(stack.baseUrl, "approver@vega-industries.com");
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
  await withDb(stack, async (client) => {
    await client.query(
      "INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [DEFAULT_TENANT_ID, paymentId, "system:third-approver", "System (third approver)"]
    );
    await client.query(
      "UPDATE payment.payments SET approvals = (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1), status = CASE WHEN (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1) >= required_approvals THEN 'Approved' ELSE status END WHERE id = $1",
      [paymentId]
    );
  });

  // Verify the payment now has 2 distinct approval rows
  const approvalList = await api(stack.baseUrl, `/payments/${paymentId}/approvals`, {
    headers: martaHeaders(martaCsrf)
  });
  assert.equal(approvalList.status, 200);
  assert.ok(Array.isArray(approvalList.data));
  assert.equal(approvalList.data.length, 2, "should have 2 approval rows");
});

test("creator self-approval above threshold returns 403", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  const loginRes = await login(stack.baseUrl, "marta@vega-industries.com");
  assert.equal(loginRes.status, 200);
  const session = extractCookie(loginRes.setCookie, "session");
  const csrf = extractCookie(loginRes.setCookie, "csrf");
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
  const stack = await startStackFor(t, { extraEnv: { INTERNAL_AUTH_REQUIRED: "true" } });

  // Try to call payment-service directly with a forged acting-user header
  const paymentPort = stack.ports.payment;
  const res = await fetch(`http://127.0.0.1:${paymentPort}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Acting-User": JSON.stringify({ id: "attacker", display: "Hacker" }),
      "X-Tenant-Id": DEFAULT_TENANT_ID
    },
    body: JSON.stringify({ amount: 1, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(res.status, 401, "forged acting-user without valid signature must be rejected");
});

test("N-1 distinct approvers leaves payment in PendingApproval", async (t) => {
  const stack = await startStackFor(t, { authRequired: true });

  // Login as approver (not creator) to approve a payment created by another user
  const approverLogin = await login(stack.baseUrl, "approver@vega-industries.com");
  assert.equal(approverLogin.status, 200);
  const approverSession = extractCookie(approverLogin.setCookie, "session");
  const approverCsrf = extractCookie(approverLogin.setCookie, "csrf");
  const approverHeaders = { Cookie: `session=${approverSession}; csrf=${approverCsrf}`, "X-Csrf-Token": approverCsrf };

  // Login as marta to create the payment
  const martaLogin = await login(stack.baseUrl, "marta@vega-industries.com");
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
