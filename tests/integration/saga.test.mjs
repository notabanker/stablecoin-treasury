import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack } from "../helpers/stack.mjs";
import { DEFAULT_TENANT_ID } from "../../packages/shared/tenant.mjs";

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

test("saga records execution attempts for every step", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "saga-attempts-1" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;

  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });
  const exec = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  assert.ok(exec.data.accepted, "execute should be accepted for async saga");

  await waitForSettlement(stack.baseUrl, paymentId);

  // Verify execution attempts exist
  const attemptsRes = await api(stack.baseUrl, `/payments/${paymentId}/attempts`);
  assert.ok(attemptsRes.data.attempts?.length >= 4, "saga should record at least 4 step attempts");

  const steps = attemptsRes.data.attempts.map((a) => a.step);
  assert.ok(steps.includes("policy_check"));
  assert.ok(steps.includes("ledger_debit"));
  assert.ok(steps.includes("settlement"));
});

test("saga is idempotent — re-executing an already-executing payment does not enqueue a second job", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "saga-idempotent-1" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;

  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });

  // First execute enqueues the saga
  const first = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  assert.ok(first.data.accepted);

  // Second execute should return "already in progress"
  const second = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  assert.ok(second.data.accepted, "second execute to Executing payment should still be accepted");
  assert.equal(second.data.payment.status, "Executing");

  await waitForSettlement(stack.baseUrl, paymentId);

  // Third execute on a settled payment
  const third = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  assert.equal(third.data.accepted, false, "execute on settled payment should not be accepted");
  assert.equal(third.data.payment.status, "Settled");

  // Wallet should be debited exactly once
  const state = await api(stack.baseUrl, "/state");
  const settled = state.data.payments.find((p) => p.id === paymentId);
  assert.equal(settled.status, "Settled");
});

test("repair endpoint lists stuck and failed payments", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const state = await api(stack.baseUrl, "/repair");
  assert.equal(state.status, 200);
  assert.ok(Array.isArray(state.data), "repair list should be an array");
});

test("execution-time policy block moves payment to Failed instead of leaving it stuck in Executing", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const body = (key, amount) => ({
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ amount, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const first = await api(stack.baseUrl, "/payments", body("drain-first", 300000));
  const second = await api(stack.baseUrl, "/payments", body("drain-second", 100000));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  await api(stack.baseUrl, `/payments/${first.data.payment.id}/approve`, { method: "POST" });
  // V6 four-eyes: same approver twice is rejected. Insert a distinct second approval via DB
  // so the test can exercise the full two-approval flow in dev mode.
  await withDb(stack, async (client) => {
    await client.query(
      "INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [DEFAULT_TENANT_ID, first.data.payment.id, "system:second-approver", "System (second approver)"]
    );
    await client.query(
      "UPDATE payment.payments SET approvals = (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1), status = 'Approved' WHERE id = $1 AND (SELECT COUNT(DISTINCT approver_id) FROM payment.payment_approvals WHERE payment_id = $1) >= required_approvals",
      [first.data.payment.id]
    );
  });
  await api(stack.baseUrl, `/payments/${second.data.payment.id}/approve`, { method: "POST" });

  const executeFirst = await api(stack.baseUrl, `/payments/${first.data.payment.id}/execute`, { method: "POST" });
  assert.equal(executeFirst.status, 200);
  const firstSettledState = await waitForSettlement(stack.baseUrl, first.data.payment.id);
  assert.equal(firstSettledState.data.payments.find((payment) => payment.id === first.data.payment.id).status, "Settled");

  await withDb(stack, async (client) => {
    await client.query("UPDATE payment.payments SET status = 'Executing' WHERE tenant_id = $1 AND id = $2 AND status = 'Approved'", [
      DEFAULT_TENANT_ID,
      second.data.payment.id
    ]);
    await client.query(
      `INSERT INTO platform.jobs (tenant_id, type, payload, max_attempts)
       VALUES ($1, 'execute-payment', $2, 1)`,
      [DEFAULT_TENANT_ID, JSON.stringify({ paymentId: second.data.payment.id, tenantId: DEFAULT_TENANT_ID })]
    );
  });

  const finalState = await waitForSettlement(stack.baseUrl, second.data.payment.id);
  const failed = finalState.data.payments.find((payment) => payment.id === second.data.payment.id);
  assert.equal(failed.status, "Failed");

  const repair = await api(stack.baseUrl, "/repair");
  assert.ok(repair.data.some((item) => item.payment.id === failed.id), "failed payment should be repair-visible");
  const attempts = await api(stack.baseUrl, `/payments/${failed.id}/attempts`);
  assert.ok(attempts.data.attempts.some((attempt) => attempt.step === "policy_check" && attempt.outcome === "error"));
});

test("consumer inbox deduplicates outbox redelivery side effects", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const suffix = Date.now().toString(36);
  const alertTitle = `Dedup alert ${suffix}`;
  const auditAction = `Dedup audit ${suffix}`;
  const reconIssue = `Dedup exception ${suffix}`;
  const [alertEventId, auditEventId, reconEventId] = await withDb(stack, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES
         ($1, 'test', 'alert-dedup', 'operations.alert_created', '{}'::jsonb),
         ($1, 'test', 'audit-dedup', 'audit.event_recorded', '{}'::jsonb),
         ($1, 'test', 'recon-dedup', 'reconciliation.exception_opened', '{}'::jsonb)
       RETURNING id
      `,
      [DEFAULT_TENANT_ID]
    );
    return rows.map((row) => row.id);
  });

  const operationsUrl = `http://127.0.0.1:${stack.ports.operations}`;
  const reconciliationUrl = `http://127.0.0.1:${stack.ports.reconciliation}`;
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await servicePost(operationsUrl, "/alerts", alertEventId, {
      severity: "High",
      title: alertTitle,
      detail: "duplicate delivery test"
    })).status, 200);
    assert.equal((await servicePost(operationsUrl, "/audit", auditEventId, {
      actor: "Relay test",
      action: auditAction,
      object: "Inbox",
      detail: "duplicate delivery test"
    })).status, 200);
    assert.equal((await servicePost(reconciliationUrl, "/reconciliation/exceptions", reconEventId, {
      payment: { id: `pay-dedup-${suffix}`, amount: 10, asset: "EURC" },
      issue: reconIssue,
      source: "Relay test"
    })).status, 200);
  }

  await withDb(stack, async (client) => {
    const { rows: alertRows } = await client.query("SELECT COUNT(*)::int AS count FROM operations.alerts WHERE tenant_id = $1 AND title = $2", [
      DEFAULT_TENANT_ID,
      alertTitle
    ]);
    const { rows: auditRows } = await client.query("SELECT COUNT(*)::int AS count FROM operations.audit_events WHERE tenant_id = $1 AND action = $2", [
      DEFAULT_TENANT_ID,
      auditAction
    ]);
    const { rows: reconRows } = await client.query("SELECT COUNT(*)::int AS count FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND issue = $2", [
      DEFAULT_TENANT_ID,
      reconIssue
    ]);
    const { rows: inboxRows } = await client.query("SELECT COUNT(*)::int AS count FROM platform.inbox_events WHERE event_id = ANY($1::uuid[])", [
      [alertEventId, auditEventId, reconEventId]
    ]);
    assert.equal(alertRows[0].count, 1);
    assert.equal(auditRows[0].count, 1);
    assert.equal(reconRows[0].count, 1);
    assert.equal(inboxRows[0].count, 3);
  });
});

test("repair retry re-enqueues an executing payment", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "saga-repair-3" },
    body: JSON.stringify({ amount: 5000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;

  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });

  // Execute to enqueue saga
  await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });

  // While the saga is running (payment is Executing), call repair/retry
  const retry = await api(stack.baseUrl, `/repair/${paymentId}/retry`, { method: "POST" });
  assert.equal(retry.status, 200, "repair retry should be accepted for an Executing payment");
  assert.equal(retry.data.accepted, true);
  assert.ok(retry.data.jobId, "repair response should identify the newly enqueued job");

  // Wait for saga to eventually settle
  await waitForSettlement(stack.baseUrl, paymentId);
});

test("execute on already-settled payment returns without re-enqueueing", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "saga-settled-1" },
    body: JSON.stringify({ amount: 1000, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  const paymentId = create.data.payment.id;

  await api(stack.baseUrl, `/payments/${paymentId}/approve`, { method: "POST" });
  await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  await waitForSettlement(stack.baseUrl, paymentId);

  // Re-execute settled payment
  const retry = await api(stack.baseUrl, `/payments/${paymentId}/execute`, { method: "POST" });
  assert.equal(retry.data.accepted, false);
  assert.equal(retry.data.payment.status, "Settled");
  assert.equal(retry.data.message, "Already settled");
});

async function waitForSettlement(baseUrl, paymentId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await api(baseUrl, "/state");
    const payment = state.data.payments?.find((p) => p.id === paymentId);
    if (payment && (payment.status === "Settled" || payment.status === "Failed" || payment.status === "Blocked")) {
      return state;
    }
    await sleep(200);
  }
  throw new Error(`Payment ${paymentId} did not settle within ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function servicePost(baseUrl, path, eventId, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Event-Id": eventId,
      "X-Tenant-Id": DEFAULT_TENANT_ID
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function withDb(stack, fn) {
  const client = new pg.Client({ connectionString: databaseUrl(stack.databaseName) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function databaseUrl(databaseName) {
  const url = new URL(process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres");
  url.pathname = `/${databaseName}`;
  return url.toString();
}
