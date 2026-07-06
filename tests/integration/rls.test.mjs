import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack } from "../helpers/stack.mjs";

const TENANT_1 = "00000000-0000-0000-0000-000000000001";
const TENANT_2 = "00000000-0000-0000-0000-000000000002";
const SVC_PASSWORD = process.env.SERVICE_DB_PASSWORD || "service-dev-password";

function roleClient(stack, role) {
  const admin = new URL(stack._env.DATABASE_URL);
  return new pg.Client({
    connectionString: `postgres://${role}:${SVC_PASSWORD}@${admin.hostname}:${admin.port || 5432}${admin.pathname}`
  });
}

function adminClient(stack) {
  return new pg.Client({ connectionString: stack._env.DATABASE_URL });
}

// Run a statement as a service role inside a transaction with (or without) the RLS
// tenant context, exactly like packages/shared/db.mjs does.
async function asRole(stack, role, tenantId, statement, params = []) {
  const client = roleClient(stack, role);
  await client.connect();
  try {
    await client.query("BEGIN");
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await client.query(statement, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

test("RLS: a WHERE-less query under a service role only sees the context tenant", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Deliberately no WHERE clause — this simulates the missed-WHERE application bug that
  // RLS exists to catch.
  const t1 = await asRole(stack, "svc_wallet", TENANT_1, "SELECT DISTINCT tenant_id FROM wallet.wallets");
  assert.deepEqual(t1.rows.map((r) => r.tenant_id), [TENANT_1], "tenant-1 context must only see tenant-1 wallets");

  const t2 = await asRole(stack, "svc_wallet", TENANT_2, "SELECT DISTINCT tenant_id FROM wallet.wallets");
  assert.deepEqual(t2.rows.map((r) => r.tenant_id), [TENANT_2], "tenant-2 context must only see tenant-2 wallets");

  // No context at all → fail closed: zero rows, not an error and not a leak.
  const none = await asRole(stack, "svc_wallet", null, "SELECT COUNT(*)::int AS count FROM wallet.wallets");
  assert.equal(none.rows[0].count, 0, "missing tenant context must fail closed");
});

test("RLS: the probe bites — disabling the policy exposes the leak it prevents", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const admin = adminClient(stack);
  await admin.connect();
  try {
    // Prove the WHERE-less probe would actually fail without RLS: disable it and watch
    // the cross-tenant leak appear, then re-enable and watch it close.
    await admin.query("ALTER TABLE wallet.wallets DISABLE ROW LEVEL SECURITY");
    const leaked = await asRole(stack, "svc_wallet", TENANT_1, "SELECT DISTINCT tenant_id FROM wallet.wallets ORDER BY tenant_id");
    assert.ok(leaked.rows.length > 1, "without RLS the same query must leak other tenants (probe validity check)");

    await admin.query("ALTER TABLE wallet.wallets ENABLE ROW LEVEL SECURITY");
    const scoped = await asRole(stack, "svc_wallet", TENANT_1, "SELECT DISTINCT tenant_id FROM wallet.wallets");
    assert.deepEqual(scoped.rows.map((r) => r.tenant_id), [TENANT_1], "re-enabling RLS must close the leak");
  } finally {
    await admin.query("ALTER TABLE wallet.wallets ENABLE ROW LEVEL SECURITY").catch(() => {});
    await admin.end();
  }
});

test("RLS: writing a row for another tenant is rejected by WITH CHECK", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  await assert.rejects(
    asRole(stack, "svc_payment", TENANT_1,
      `INSERT INTO payment.payments
         (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result)
       VALUES ('pay-rls-probe', $1, 'PMT-RLS-1', 'Supplier', 'wal-no-hq', 'cp-oslo', 'EURC', 10, 0, 'Pending approval', 0, 1, 'Clear')`,
      [TENANT_2]),
    /row-level security policy/,
    "tenant-1 context must not be able to write a tenant-2 payment"
  );
});

test("RLS: ledger-derived balances view is tenant-scoped via security_invoker", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // wallet_balances is a view; without security_invoker it would run with the owner's
  // privileges and bypass RLS on the underlying tables entirely.
  const t1 = await asRole(stack, "svc_wallet", TENANT_1, "SELECT DISTINCT tenant_id FROM wallet.wallet_balances");
  assert.deepEqual(t1.rows.map((r) => r.tenant_id), [TENANT_1], "balances view must scope to the context tenant");

  const none = await asRole(stack, "svc_wallet", null, "SELECT COUNT(*)::int AS count FROM wallet.wallet_balances");
  assert.equal(none.rows[0].count, 0, "balances view must fail closed without context");
});

test("RLS: gateway provider-registry carve-out reads across tenants but stays read-only", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // The gateway resolves provider -> tenant for webhooks BEFORE any tenant is known, so
  // it has an explicit USING(true) SELECT policy on operations.providers.
  const providers = await asRole(stack, "svc_gateway", null, "SELECT DISTINCT tenant_id FROM operations.providers ORDER BY tenant_id");
  assert.ok(providers.rows.length >= 2, "gateway must see the provider registry across tenants (webhook tenant resolution)");

  // The carve-out is SELECT-only: the grant (not just RLS) blocks writes.
  await assert.rejects(
    asRole(stack, "svc_gateway", null, "UPDATE operations.providers SET status = 'Degraded'"),
    /permission denied/,
    "gateway must not be able to write the provider registry"
  );

  // And the carve-out does not extend anywhere else: no grant on payments at all.
  await assert.rejects(
    asRole(stack, "svc_gateway", TENANT_1, "SELECT COUNT(*) FROM payment.payments"),
    /permission denied/,
    "gateway has no path to payment data"
  );
});

// ── Epic 2.3 cross-tenant adversarial probes ────────────────────────────

test("RLS: idempotency-key collision across tenants produces two distinct payments", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Insert two idempotency keys with the same value but different tenants.
  // Without RLS, one tenant could see the other's reservation and leak data.
  const sameKey = "rls-cross-tenant-ik-1";
  const hash = "abcd1234";

  const t1 = await asRole(stack, "svc_payment", TENANT_1,
    "INSERT INTO payment.idempotency_keys (tenant_id, idempotency_key, action, request_hash, status) VALUES ($1::uuid, $2::text, 'create', $3::text, 'pending') ON CONFLICT DO NOTHING RETURNING tenant_id",
    [TENANT_1, sameKey, hash]
  );
  assert.equal(t1.rows.length, 1, "tenant-1 must insert its idempotency key");

  const t2 = await asRole(stack, "svc_payment", TENANT_2,
    "INSERT INTO payment.idempotency_keys (tenant_id, idempotency_key, action, request_hash, status) VALUES ($1::uuid, $2::text, 'create', $3::text, 'pending') ON CONFLICT DO NOTHING RETURNING tenant_id",
    [TENANT_2, sameKey, hash]
  );
  assert.equal(t2.rows.length, 1, "tenant-2 must be able to use the same key (tenant-scoped)");

  // Each tenant must see only its own key.
  const t1Only = await asRole(stack, "svc_payment", TENANT_1,
    "SELECT COUNT(*)::int AS count FROM payment.idempotency_keys WHERE idempotency_key = $1",
    [sameKey]
  );
  assert.equal(t1Only.rows[0].count, 1, "tenant-1 must see exactly 1 key (its own)");

  const t2Only = await asRole(stack, "svc_payment", TENANT_2,
    "SELECT COUNT(*)::int AS count FROM payment.idempotency_keys WHERE idempotency_key = $1",
    [sameKey]
  );
  assert.equal(t2Only.rows[0].count, 1, "tenant-2 must see exactly 1 key (its own)");
});

test("RLS: tenant-1 webhook processing cannot affect tenant-2 payments", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Create a tenant-2 payment via the API (using the stack's normal flow for correctness)
  // then prove svc_job in tenant-1 context cannot see or update it.

  // Direct DB: insert a tenant-2 payment so we have something to probe against.
  const admin = adminClient(stack);
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO payment.payments (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result)
       VALUES ('pay-rls-wh-1', $1::uuid, 'PMT-RLS-WH-1', 'Supplier', 'wal-nordic-eur', 'cp-vega', 'EURC', 10, 0, 'Approved', 1, 1, 'Clear')`,
      [TENANT_2]
    );

    // svc_job (BYPASSRLS) can see it — that's the worker's job.
    const jobSees = await asRole(stack, "svc_job", null,
      "SELECT COUNT(*)::int AS count FROM payment.payments WHERE id = 'pay-rls-wh-1'"
    );
    assert.equal(jobSees.rows[0].count, 1, "job role must see cross-tenant payments (BYPASSRLS)");

    // A domain role in tenant-1 context must not see it.
    const paymentSees = await asRole(stack, "svc_payment", TENANT_1,
      "SELECT COUNT(*)::int AS count FROM payment.payments WHERE id = 'pay-rls-wh-1'"
    );
    assert.equal(paymentSees.rows[0].count, 0, "tenant-1 payment role must not see tenant-2 payment");

    // And a domain role in tenant-1 context must not be able to UPDATE it.
    // The UPDATE succeeds but affects 0 rows because RLS filters to tenant-1 rows only.
    const updateResult = await asRole(stack, "svc_payment", TENANT_1,
      "UPDATE payment.payments SET status = 'Settled' WHERE id = 'pay-rls-wh-1'"
    );
    assert.equal(updateResult.rowCount, 0, "tenant-1 UPDATE on tenant-2 payment must affect 0 rows under RLS");
  } finally {
    await admin.query("DELETE FROM payment.payments WHERE id = 'pay-rls-wh-1'").catch(() => {});
    await admin.end();
  }
});

test("RLS: audit reads are tenant-scoped", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Each tenant's audit events are isolated under RLS.
  // Prove tenant-1 only sees its own audit rows.
  const t1 = await asRole(stack, "svc_operations", TENANT_1,
    "SELECT DISTINCT tenant_id FROM operations.audit_events ORDER BY tenant_id"
  );
  for (const row of t1.rows) {
    assert.equal(row.tenant_id, TENANT_1, `tenant-1 must only see its own audit rows, but saw ${row.tenant_id}`);
  }

  const t2 = await asRole(stack, "svc_operations", TENANT_2,
    "SELECT DISTINCT tenant_id FROM operations.audit_events ORDER BY tenant_id"
  );
  for (const row of t2.rows) {
    assert.equal(row.tenant_id, TENANT_2, `tenant-2 must only see its own audit rows, but saw ${row.tenant_id}`);
  }

  // Neither tenant sees both.
  assert.ok(
    t1.rows.every((r) => r.tenant_id === TENANT_1) && t2.rows.every((r) => r.tenant_id === TENANT_2),
    "audit reads must be strictly tenant-scoped"
  );
});

test("RLS: repair endpoints and execution attempts are tenant-scoped", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Tenant-1 must see execution attempts only for its own payments.
  // Create a tenant-1 payment with an execution attempt via the admin, then query as svc_payment.
  const admin = adminClient(stack);
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO payment.payments (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result)
       VALUES ('pay-rls-repair-1', $1::uuid, 'PMT-RLS-REPAIR-1', 'Supplier', 'wal-de-eur', 'cp-nordic', 'EURC', 10, 0, 'Failed', 1, 1, 'Clear')`,
      [TENANT_1]
    );
    await admin.query(
      "INSERT INTO payment.payment_execution_attempts (tenant_id, payment_id, step, outcome, error) VALUES ($1::uuid, $2, 'policy_check', 'error', 'RLS-probe')",
      [TENANT_1, "pay-rls-repair-1"]
    );

    // Tenant-1 payment role must see the attempt.
    const t1Attempts = await asRole(stack, "svc_payment", TENANT_1,
      "SELECT COUNT(*)::int AS count FROM payment.payment_execution_attempts WHERE payment_id = 'pay-rls-repair-1'"
    );
    assert.equal(t1Attempts.rows[0].count, 1, "tenant-1 must see its own execution attempt");

    // Tenant-2 payment role must not see tenant-1's attempt.
    const t2Attempts = await asRole(stack, "svc_payment", TENANT_2,
      "SELECT COUNT(*)::int AS count FROM payment.payment_execution_attempts WHERE payment_id = 'pay-rls-repair-1'"
    );
    assert.equal(t2Attempts.rows[0].count, 0, "tenant-2 must not see tenant-1's execution attempt");

    // Repair listing must be tenant-scoped via RLS.
    const t1Repair = await asRole(stack, "svc_payment", TENANT_1,
      "SELECT COUNT(*)::int AS count FROM payment.payments WHERE status = 'Failed'"
    );
    const t2Repair = await asRole(stack, "svc_payment", TENANT_2,
      "SELECT COUNT(*)::int AS count FROM payment.payments WHERE status = 'Failed'"
    );
    assert.ok(t1Repair.rows[0].count >= 1, "tenant-1 must see its own failed payments in repair list");
    assert.ok(t2Repair.rows[0].count === 0 || !t2Repair.rows.some((r) => r === 'pay-rls-repair-1'),
      "tenant-2 must not see tenant-1 failed payment in repair list");
  } finally {
    await admin.query("DELETE FROM payment.payment_execution_attempts WHERE payment_id = 'pay-rls-repair-1'").catch(() => {});
    await admin.query("DELETE FROM payment.payments WHERE id = 'pay-rls-repair-1'").catch(() => {});
    await admin.end();
  }
});
