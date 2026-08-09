import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack } from "../helpers/stack.mjs";

// Audit finding #1 (migration 0057): the SECURITY DEFINER reset_seed functions
// from 0055 took a caller-supplied tenant UUID with no check against the
// session's app.tenant_id RLS context. They must fail closed on mismatch or
// missing context.

const TENANT_1 = "00000000-0000-0000-0000-000000000001";
const TENANT_2 = "00000000-0000-0000-0000-000000000002";

const serviceDbPassword = process.env.SERVICE_DB_PASSWORD || "service-dev-password";

// Same per-role URL accessor as role-isolation.test.mjs (stack.roleUrls does
// not exist in the harness).
function roleUrl(stack, role) {
  return `postgres://${role}:${serviceDbPassword}@127.0.0.1:5432/${stack.databaseName}`;
}

// One connection per call — never a long-lived probe connection (57P01 lesson).
// Multi-statement strings lose rows in pg, so context + call are two queries
// on the same short-lived connection.
async function asRole(stack, role, setTenant, callQuery, params) {
  const client = new pg.Client({ connectionString: roleUrl(stack, role) });
  await client.connect();
  try {
    if (setTenant) {
      await client.query(`SET app.tenant_id = '${setTenant}'`);
    }
    return await client.query(callQuery, params);
  } finally {
    await client.end();
  }
}

test("reset_seed refuses a tenant different from the session context", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await assert.rejects(
    asRole(stack, "svc_payment", TENANT_1,
      `SELECT payment.reset_seed('${TENANT_2}')`),
    /tenant mismatch/
  );
});

test("reset_seed refuses a call with no tenant context (fail closed)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await assert.rejects(
    asRole(stack, "svc_payment", null, `SELECT payment.reset_seed('${TENANT_1}')`),
    /tenant mismatch/
  );
});

test("reset_seed succeeds when the session context matches", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const res = await asRole(stack, "svc_payment", TENANT_1,
    `SELECT payment.reset_seed('${TENANT_1}') AS ok`);
  assert.equal(res.rows.length, 1); // void function, no error (void renders as '')
});
