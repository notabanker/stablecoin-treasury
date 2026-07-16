import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "../helpers/stack.mjs";

// Epic 2.1: Role isolation — verify each service role cannot access foreign schemas.
// Uses direct pg connections with per-role credentials to query the test database.

const serviceDbPassword = process.env.SERVICE_DB_PASSWORD || "service-dev-password";
const baseUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";

function roleUrl(stack, role) {
  return `postgres://${role}:${serviceDbPassword}@127.0.0.1:5432/${stack.databaseName}`;
}

async function expectDenied(stack, role, schema, table, message) {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: roleUrl(stack, role) });
  try {
    await client.connect();
    await client.query(`SELECT COUNT(*) FROM ${schema}.${table}`);
    assert.fail(`${message}: expected permission denied but query succeeded (role ${role} on ${schema}.${table})`);
  } catch (error) {
    assert.ok(
      /permission denied/i.test(error.message),
      `${message}: ${error.message}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function expectAllowed(stack, role, schema, table, message) {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: roleUrl(stack, role) });
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT COUNT(*) AS c FROM ${schema}.${table}`);
    assert.ok(Number.isFinite(Number(rows[0]?.c)), `${message}: got ${JSON.stringify(rows[0])}`);
  } finally {
    await client.end().catch(() => {});
  }
}

test("wallet role cannot SELECT from payment.payments", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectDenied(stack, "svc_wallet", "payment", "payments", "wallet→payment");
});

test("payment role cannot SELECT from wallet.ledger_transactions", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectDenied(stack, "svc_payment", "wallet", "ledger_transactions", "payment→wallet");
});

test("policy role cannot SELECT from identity.users", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectDenied(stack, "svc_policy", "identity", "users", "policy→identity");
});

test("accounting role can SELECT from accounting.journal_entries", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectAllowed(stack, "svc_accounting", "accounting", "journal_entries", "accounting→accounting");
});

test("relay role can SELECT from platform.outbox_events", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectAllowed(stack, "svc_relay", "platform", "outbox_events", "relay→outbox");
});

test("jobs role can INSERT into platform.jobs", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: roleUrl(stack, "svc_job") });
  try {
    await client.connect();
    await client.query(
      "INSERT INTO platform.jobs (tenant_id, type, payload, status, run_at) VALUES ($1::uuid, $2::text, $3::jsonb, $4::text, now())",
      ["00000000-0000-0000-0000-000000000001", "test", JSON.stringify({}), "pending"]
    );
  } catch (error) {
    assert.fail(`job→jobs INSERT: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
});

test("payment role can SELECT from platform.jobs (needed for repair)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectAllowed(stack, "svc_payment", "platform", "jobs", "payment→jobs");
});

// ── H5: Tightened blanket grants ─────────────────────────────────────────────

test("svc_operations cannot UPDATE or DELETE audit_events", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: roleUrl(stack, "svc_operations") });
  try {
    await client.connect();
    await client.query("UPDATE operations.audit_events SET detail = 'x' WHERE 1=0");
    assert.fail("expected permission denied for UPDATE on audit_events");
  } catch (error) {
    assert.ok(/permission denied/i.test(error.message), `UPDATE on audit_events: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
  const client2 = new pg.Client({ connectionString: roleUrl(stack, "svc_operations") });
  try {
    await client2.connect();
    await client2.query("DELETE FROM operations.audit_events WHERE 1=0");
    assert.fail("expected permission denied for DELETE on audit_events");
  } catch (error) {
    assert.ok(/permission denied/i.test(error.message), `DELETE on audit_events: ${error.message}`);
  } finally {
    await client2.end().catch(() => {});
  }
});

test("svc_payment cannot UPDATE or DELETE payment_events", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  for (const op of ["UPDATE", "DELETE"]) {
    const pg = await import("pg");
    const client = new pg.Client({ connectionString: roleUrl(stack, "svc_payment") });
    try {
      await client.connect();
      await client.query(
        op === "UPDATE"
          ? "UPDATE payment.payment_events SET actor = 'x' WHERE 1=0"
          : "DELETE FROM payment.payment_events WHERE 1=0"
      );
      assert.fail(`expected permission denied for ${op} on payment_events`);
    } catch (error) {
      assert.ok(/permission denied/i.test(error.message), `${op} on payment_events: ${error.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
});

test("svc_payment cannot UPDATE or DELETE payment_approvals", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  for (const op of ["UPDATE", "DELETE"]) {
    const pg = await import("pg");
    const client = new pg.Client({ connectionString: roleUrl(stack, "svc_payment") });
    try {
      await client.connect();
      await client.query(
        op === "UPDATE"
          ? "UPDATE payment.payment_approvals SET approver_display = 'x' WHERE 1=0"
          : "DELETE FROM payment.payment_approvals WHERE 1=0"
      );
      assert.fail(`expected permission denied for ${op} on payment_approvals`);
    } catch (error) {
      assert.ok(/permission denied/i.test(error.message), `${op} on payment_approvals: ${error.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
});

test("svc_job cannot UPDATE or DELETE payment_events or payment_approvals", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  for (const table of ["payment_events", "payment_approvals"]) {
    for (const op of ["UPDATE", "DELETE"]) {
      const pg = await import("pg");
      const client = new pg.Client({ connectionString: roleUrl(stack, "svc_job") });
      try {
        await client.connect();
        await client.query(
          op === "UPDATE"
            ? `UPDATE payment.${table} SET ${table === "payment_events" ? "actor" : "approver_display"} = 'x' WHERE 1=0`
            : `DELETE FROM payment.${table} WHERE 1=0`
        );
        assert.fail(`expected permission denied for ${op} on ${table}`);
      } catch (error) {
        assert.ok(/permission denied/i.test(error.message), `${op} on ${table}: ${error.message}`);
      } finally {
        await client.end().catch(() => {});
      }
    }
  }
});

test("svc_wallet cannot DELETE from ledger tables", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  for (const table of ["ledger_accounts", "ledger_transactions", "ledger_entries"]) {
    const pg = await import("pg");
    const client = new pg.Client({ connectionString: roleUrl(stack, "svc_wallet") });
    try {
      await client.connect();
      await client.query(`DELETE FROM wallet.${table} WHERE 1=0`);
      assert.fail(`expected permission denied for DELETE on ${table}`);
    } catch (error) {
      assert.ok(/permission denied/i.test(error.message), `DELETE on ${table}: ${error.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
});

test("svc_job can SELECT from identity.tenants (H3 support)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await expectAllowed(stack, "svc_job", "identity", "tenants", "job→tenants");
});
