import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../../db/scripts/migrate.mjs";
import { closeAllPools, query } from "../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../packages/shared/tenant.mjs";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "../../services/payment-service/src/idempotency.mjs";

const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";

// db.mjs caches one pg.Pool per service name for the life of the process. Each test here needs
// its own throwaway database, so each one closes and clears those pools before pointing
// DATABASE_URL at a fresh database -- otherwise a later test would silently keep querying an
// earlier test's already-dropped database through a stale cached connection.
async function withFreshDatabase(fn) {
  const name = `treasury_test_idem_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
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

test("DB-backed idempotency: reserve/complete/release lifecycle", async () => {
  await withFreshDatabase(async () => {
    // idempotency_keys.payment_id has a real FK to payments.id, so completing a reservation
    // against a payment that doesn't exist correctly fails -- insert one first.
    await query(
      "payment",
      `INSERT INTO payment.payments (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status)
       VALUES ('pay-abc', $1, 'PMT-9001', 'Supplier', 'wal-x', 'cp-x', 'EURC', 100, 1, 'Pending approval')`,
      [DEFAULT_TENANT_ID]
    );

    const hash = hashRequest({ amount: 100 });
    const first = await reserveIdempotencyKey("create", "key-1", hash);
    assert.equal(first.outcome, "reserved");

    const differentHash = hashRequest({ amount: 999 });
    const mismatch = await reserveIdempotencyKey("create", "key-1", differentHash);
    assert.equal(mismatch.outcome, "hash_mismatch");

    await completeIdempotencyKey("create", "key-1", "pay-abc");
    const done = await reserveIdempotencyKey("create", "key-1", hash);
    assert.deepEqual(done, { outcome: "done", paymentId: "pay-abc" });

    const secondKeyHash = hashRequest({ amount: 5 });
    await reserveIdempotencyKey("create", "key-2", secondKeyHash);
    await releaseIdempotencyKey("create", "key-2");
    const reReserved = await reserveIdempotencyKey("create", "key-2", secondKeyHash);
    assert.equal(reReserved.outcome, "reserved");
  });
});

test("DB-backed idempotency: concurrent reservations on the same key serialize instead of racing", async () => {
  await withFreshDatabase(async () => {
    const hash = hashRequest({ amount: 42 });
    const results = await Promise.all(Array.from({ length: 15 }, () => reserveIdempotencyKey("create", "race-key", hash)));
    const reservedCount = results.filter((r) => r.outcome === "reserved").length;
    assert.equal(reservedCount, 1, "exactly one caller should win the reservation");
  });
});

test("allocateReference issues unique references under concurrency", async () => {
  await withFreshDatabase(async () => {
    const refs = await Promise.all(Array.from({ length: 30 }, () => allocateReference()));
    assert.equal(new Set(refs).size, 30, "all references must be unique");
  });
});

test("wallet debit UPDATE...WHERE prevents overdraft under concurrent debits", async () => {
  await withFreshDatabase(async () => {
    await query(
      "wallet",
      "INSERT INTO wallet.legal_entities (id, tenant_id, name, jurisdiction, base_currency, erp_code) VALUES ('ent-x', $1, 'X', 'DE', 'EUR', 'X-1')",
      [DEFAULT_TENANT_ID]
    );
    await query(
      "wallet",
      "INSERT INTO wallet.assets (id, tenant_id, name, currency, issuer, chain, classification, status, risk, provider_id) VALUES ('EURX', $1, 'X', 'EUR', 'X', 'X', 'X', 'Enabled', 'Low', 'prov-x')",
      [DEFAULT_TENANT_ID]
    );
    await query(
      "wallet",
      "INSERT INTO wallet.wallets (id, tenant_id, entity_id, provider_id, asset_id, address, custody, status, balance) VALUES ('wal-x', $1, 'ent-x', 'prov-x', 'EURX', '0x0', 'x', 'Active', 100)",
      [DEFAULT_TENANT_ID]
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        query("wallet", "UPDATE wallet.wallets SET balance = balance - 20 WHERE id = 'wal-x' AND balance >= 20 RETURNING balance").then(
          (r) => r.rows.length > 0
        )
      )
    );
    const succeeded = results.filter(Boolean).length;
    assert.equal(succeeded, 5, "exactly 5 of 10 concurrent 20-unit debits should succeed against a balance of 100");

    const { rows } = await query("wallet", "SELECT balance FROM wallet.wallets WHERE id = 'wal-x'");
    assert.equal(Number(rows[0].balance), 0);
  });
});
