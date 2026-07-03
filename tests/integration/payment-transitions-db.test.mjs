import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../../db/scripts/migrate.mjs";
import { closeAllPools, query } from "../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../packages/shared/tenant.mjs";

const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";

async function withFreshDatabase(fn) {
  const name = `treasury_test_transitions_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), { quiet: true });
  process.env.DATABASE_URL = url.toString();

  try {
    await fn();
  } finally {
    await closeAllPools();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`);
    await cleanup.end();
  }
}

async function insertPayment(id, status) {
  await query(
    "payment",
    `INSERT INTO payment.payments (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status)
     VALUES ($1, $2, $3, 'Supplier', 'wal-x', 'cp-x', 'EURC', 100, 1, $4)`,
    [id, DEFAULT_TENANT_ID, `PMT-${id}`, status]
  );
}

test("the payment transition trigger logs every valid transition and rejects invalid ones", async () => {
  await withFreshDatabase(async () => {
    await insertPayment("pay-t1", "Pending approval");

    // Valid: Pending approval -> Approved -> Executing -> Settled.
    await query("payment", "UPDATE payment.payments SET status = 'Approved' WHERE id = 'pay-t1'");
    await query("payment", "UPDATE payment.payments SET status = 'Executing' WHERE id = 'pay-t1'");
    await query("payment", "UPDATE payment.payments SET status = 'Settled' WHERE id = 'pay-t1'");

    const { rows: events } = await query(
      "payment",
      "SELECT from_status, to_status FROM payment.payment_events WHERE payment_id = 'pay-t1' ORDER BY at"
    );
    assert.deepEqual(
      events.map((e) => [e.from_status, e.to_status]),
      [
        [null, "Pending approval"],
        ["Pending approval", "Approved"],
        ["Approved", "Executing"],
        ["Executing", "Settled"]
      ]
    );
  });
});

test("the payment transition trigger rejects skipping states", async () => {
  await withFreshDatabase(async () => {
    await insertPayment("pay-t2", "Pending approval");
    await assert.rejects(
      () => query("payment", "UPDATE payment.payments SET status = 'Settled' WHERE id = 'pay-t2'"),
      /Invalid payment status transition/
    );
    const { rows } = await query("payment", "SELECT status FROM payment.payments WHERE id = 'pay-t2'");
    assert.equal(rows[0].status, "Pending approval", "the rejected update must not have applied");
  });
});

test("the payment transition trigger rejects resurrecting a terminal payment", async () => {
  await withFreshDatabase(async () => {
    await insertPayment("pay-t3", "Cancelled");
    await assert.rejects(
      () => query("payment", "UPDATE payment.payments SET status = 'Approved' WHERE id = 'pay-t3'"),
      /Invalid payment status transition/
    );
  });
});

test("a same-status update (e.g. approvals count changing) is not logged as a transition", async () => {
  await withFreshDatabase(async () => {
    await insertPayment("pay-t4", "Pending approval");
    await query("payment", "UPDATE payment.payments SET approvals = 1 WHERE id = 'pay-t4'");
    const { rows } = await query("payment", "SELECT COUNT(*)::int AS n FROM payment.payment_events WHERE payment_id = 'pay-t4'");
    assert.equal(rows[0].n, 1, "only the initial INSERT event, no event for the no-op status update");
  });
});
