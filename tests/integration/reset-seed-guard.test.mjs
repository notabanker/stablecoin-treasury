import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TENANT_ID, TENANT_2_ID } from "../helpers/api.mjs";
import { asRole } from "../helpers/db.mjs";
import { startStack } from "../helpers/stack.mjs";

// Audit finding #1 (migration 0057): the SECURITY DEFINER reset_seed functions
// from 0055 took a caller-supplied tenant UUID with no check against the
// session's app.tenant_id RLS context. They must fail closed on mismatch or
// missing context.

test("reset_seed refuses a tenant different from the session context", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await assert.rejects(
    asRole(stack, "svc_payment", DEFAULT_TENANT_ID,
      `SELECT payment.reset_seed('${TENANT_2_ID}')`),
    /tenant mismatch/
  );
});

test("reset_seed refuses a call with no tenant context (fail closed)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  await assert.rejects(
    asRole(stack, "svc_payment", null, `SELECT payment.reset_seed('${DEFAULT_TENANT_ID}')`),
    /tenant mismatch/
  );
});

test("reset_seed succeeds when the session context matches", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const res = await asRole(stack, "svc_payment", DEFAULT_TENANT_ID,
    `SELECT payment.reset_seed('${DEFAULT_TENANT_ID}') AS ok`);
  assert.equal(res.rows.length, 1); // void function, no error (void renders as '')
});
