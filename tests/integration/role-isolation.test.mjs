import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { roleClient } from "../helpers/db.mjs";
import { startStack } from "../helpers/stack.mjs";

// Epic 2.1: Role isolation — verify each service role cannot access foreign schemas.
// Uses direct pg connections with per-role credentials to query the test database.
// One stack is shared by the whole file. Every test is a read or a deliberately-failing write
// except "jobs role can INSERT into platform.jobs", whose row is a real commit: it stays for the
// rest of the file and the running job-worker retries it to dead-letter as an unknown type.
// Nothing here asserts on job or alert state, so that is inert -- but a test added to this file
// that does must not assume a clean platform.jobs.

describe("role isolation", () => {
  let stack;

  before(async () => {
    stack = await startStack();
  });

  after(async () => {
    await stack.stop();
  });

  async function expectDenied(role, schema, table, message) {
    const client = roleClient(stack, role);
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

  async function expectAllowed(role, schema, table, message) {
    const client = roleClient(stack, role);
    try {
      await client.connect();
      const { rows } = await client.query(`SELECT COUNT(*) AS c FROM ${schema}.${table}`);
      assert.ok(Number.isFinite(Number(rows[0]?.c)), `${message}: got ${JSON.stringify(rows[0])}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  test("wallet role cannot SELECT from payment.payments", async () => {
    await expectDenied("svc_wallet", "payment", "payments", "wallet→payment");
  });

  test("payment role cannot SELECT from wallet.ledger_transactions", async () => {
    await expectDenied("svc_payment", "wallet", "ledger_transactions", "payment→wallet");
  });

  test("policy role cannot SELECT from identity.users", async () => {
    await expectDenied("svc_policy", "identity", "users", "policy→identity");
  });

  test("accounting role can SELECT from accounting.journal_entries", async () => {
    await expectAllowed("svc_accounting", "accounting", "journal_entries", "accounting→accounting");
  });

  test("relay role can SELECT from platform.outbox_events", async () => {
    await expectAllowed("svc_relay", "platform", "outbox_events", "relay→outbox");
  });

  test("jobs role can INSERT into platform.jobs", async () => {
    const client = roleClient(stack, "svc_job");
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

  test("payment role can SELECT from platform.jobs (needed for repair)", async () => {
    await expectAllowed("svc_payment", "platform", "jobs", "payment→jobs");
  });

  // ── H5: Tightened blanket grants ─────────────────────────────────────────────

  test("svc_operations cannot UPDATE or DELETE audit_events", async () => {
    for (const op of ["UPDATE", "DELETE"]) {
      const client = roleClient(stack, "svc_operations");
      try {
        await client.connect();
        await client.query(op === "UPDATE"
          ? "UPDATE operations.audit_events SET detail = 'x' WHERE 1=0"
          : "DELETE FROM operations.audit_events WHERE 1=0");
        assert.fail(`expected permission denied for ${op} on audit_events`);
      } catch (error) {
        assert.ok(/permission denied/i.test(error.message), `${op} on audit_events: ${error.message}`);
      } finally {
        await client.end().catch(() => {});
      }
    }
  });

  test("svc_payment cannot UPDATE or DELETE payment_events", async () => {
    for (const op of ["UPDATE", "DELETE"]) {
      const client = roleClient(stack, "svc_payment");
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

  test("svc_payment cannot UPDATE or DELETE payment_approvals", async () => {
    for (const op of ["UPDATE", "DELETE"]) {
      const client = roleClient(stack, "svc_payment");
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

  test("svc_job cannot UPDATE or DELETE payment_events or payment_approvals", async () => {
    for (const table of ["payment_events", "payment_approvals"]) {
      for (const op of ["UPDATE", "DELETE"]) {
        const client = roleClient(stack, "svc_job");
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

  test("svc_wallet cannot DELETE from ledger tables", async () => {
    for (const table of ["ledger_accounts", "ledger_transactions", "ledger_entries"]) {
      const client = roleClient(stack, "svc_wallet");
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

  test("svc_job can SELECT from identity.tenants (H3 support)", async () => {
    await expectAllowed("svc_job", "identity", "tenants", "job→tenants");
  });
});
