import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startStack } from "../helpers/stack.mjs";

const execFileAsync = promisify(execFile);
const TENANT_1 = "00000000-0000-0000-0000-000000000001";
const CHAIN_ALERT_TITLE = "Audit chain integrity violation";

async function withDb(stack, fn) {
  const client = new pg.Client({ connectionString: stack._env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Run the standalone verifier script against the stack's throwaway database so the CLI
// (exit codes included) is what gets proven, not just the underlying library function.
async function runVerifier(stack) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/verify-audit-chain.mjs"], {
      cwd: stack._root,
      env: { ...process.env, DATABASE_URL: stack._env.DATABASE_URL }
    });
    return { code: 0, result: JSON.parse(stdout.trim()) };
  } catch (error) {
    const raw = (error.stdout || "").trim();
    return { code: error.code ?? 1, result: raw ? JSON.parse(raw) : null };
  }
}

function postAudit(stack, body, extraHeaders = {}) {
  return fetch(`http://127.0.0.1:${stack.ports.operations}/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant-Id": TENANT_1, ...extraHeaders },
    body: JSON.stringify(body)
  });
}

test("audit chain stays valid across every insert path including demo reset", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Path 1: gateway emitSecurityAudit (login success)
  const login = await fetch(`${stack.baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(login.status, 200);

  // Path 2: operations /audit without inbox dedup (plain transaction)
  const direct = await postAudit(stack, { actor: "Probe", action: "Chain probe direct", object: "audit-chain", detail: "direct path" });
  assert.equal(direct.status, 200);

  // Path 3: outbox-relayed audit event (inbox-dedup transaction client). inbox_events.event_id
  // is an FK to outbox_events, so this path can only be exercised by a REAL relayed event:
  // creating a payment makes the payment service write an audit.event_recorded outbox row,
  // which the relay delivers to operations /audit with X-Event-Id.
  const payment = await fetch(`${stack.baseUrl}/api/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "audit-chain-path3" },
    body: JSON.stringify({ amount: 100, counterpartyId: "cp-nordic", sourceWalletId: "wal-de-eur", type: "Supplier" })
  });
  assert.equal(payment.status, 200);
  const relayed = await withDb(stack, async (db) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { rows } = await db.query(
        "SELECT id FROM operations.audit_events WHERE action LIKE 'Payment%' LIMIT 1"
      );
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  });
  assert.ok(relayed, "relay must deliver the payment audit event through the inbox-dedup path");

  // Path 4: demo reset — deletes tenant-1 audit rows and reseeds them through the chained
  // insert; the tenant chain must restart cleanly at genesis.
  const reset = await fetch(`${stack.baseUrl}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(reset.status, 200);

  // Append after the reseed to prove the rebuilt chain accepts new links.
  const postReset = await postAudit(stack, { actor: "Probe", action: "Chain probe post-reset", object: "audit-chain", detail: "after reset" });
  assert.equal(postReset.status, 200);

  const { code, result } = await runVerifier(stack);
  assert.equal(code, 0, `verifier should exit 0, got ${code}: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  assert.ok(result.checkedRows > 0, "chain should contain rows");

  // Structural assertion: per tenant, chain_seq is 1..COUNT with no duplicates.
  await withDb(stack, async (db) => {
    const { rows } = await db.query(
      `SELECT tenant_id, COUNT(*)::int AS rows, MAX(chain_seq)::int AS max_seq, COUNT(DISTINCT chain_seq)::int AS distinct_seq
       FROM operations.audit_events GROUP BY tenant_id`
    );
    for (const row of rows) {
      assert.equal(row.max_seq, row.rows, `tenant ${row.tenant_id} chain_seq must be gapless`);
      assert.equal(row.distinct_seq, row.rows, `tenant ${row.tenant_id} chain_seq must be unique`);
    }
  });
});

test("verifier detects a tampered row and an interior deletion", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // Ensure at least 3 tenant-1 rows so an interior deletion is possible.
  for (let i = 1; i <= 3; i += 1) {
    const res = await postAudit(stack, { actor: "Probe", action: `Chain probe ${i}`, object: "audit-chain", detail: `row ${i}` });
    assert.equal(res.status, 200);
  }

  const clean = await runVerifier(stack);
  assert.equal(clean.code, 0, "chain must verify clean before tampering");

  // Tamper: edit a recorded field. The row's stored hash no longer matches the recompute.
  const tampered = await withDb(stack, async (db) => {
    const { rows } = await db.query(
      "SELECT id, detail FROM operations.audit_events WHERE tenant_id = $1 ORDER BY chain_seq LIMIT 1", [TENANT_1]
    );
    await db.query("UPDATE operations.audit_events SET detail = detail || ' [tampered]' WHERE id = $1", [rows[0].id]);
    return rows[0];
  });

  const afterTamper = await runVerifier(stack);
  assert.equal(afterTamper.code, 1, "verifier must exit non-zero on a tampered row");
  assert.equal(afterTamper.result.ok, false);
  assert.equal(afterTamper.result.break.id, tampered.id, "verifier must name the tampered row");
  assert.equal(afterTamper.result.break.reason, "row_hash_mismatch");

  // Restore the original value: the chain must verify clean again (hashes were computed
  // over the original content).
  await withDb(stack, (db) =>
    db.query("UPDATE operations.audit_events SET detail = $1 WHERE id = $2", [tampered.detail, tampered.id])
  );
  const restored = await runVerifier(stack);
  assert.equal(restored.code, 0, "restoring the original value must heal verification");

  // Interior deletion: removing a middle link leaves a sequence gap.
  await withDb(stack, (db) =>
    db.query(
      `DELETE FROM operations.audit_events
       WHERE tenant_id = $1
         AND chain_seq = (SELECT MAX(chain_seq) - 1 FROM operations.audit_events WHERE tenant_id = $1)`,
      [TENANT_1]
    )
  );
  const afterDelete = await runVerifier(stack);
  assert.equal(afterDelete.code, 1, "verifier must exit non-zero on interior deletion");
  assert.equal(afterDelete.result.break.reason, "sequence_gap");
});

test("concurrent audit appends produce an unbroken gapless chain", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      postAudit(stack, { actor: "Probe", action: "Concurrent append", object: "audit-chain", detail: `parallel ${i}` })
    )
  );
  for (const res of results) assert.equal(res.status, 200);

  const { code, result } = await runVerifier(stack);
  assert.equal(code, 0, `chain must verify clean after 20 parallel appends: ${JSON.stringify(result)}`);

  await withDb(stack, async (db) => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS rows, MAX(chain_seq)::int AS max_seq
       FROM operations.audit_events WHERE tenant_id = $1`, [TENANT_1]
    );
    assert.equal(rows[0].max_seq, rows[0].rows, "parallel appends must not create gaps or duplicates");
  });
});

test("audit-chain-verify job raises one deduped alert on break and closes it when healed", async (t) => {
  const stack = await startStack({
    extraEnv: {
      AUDIT_CHAIN_VERIFY_INTERVAL_MS: "700",
      WATCHDOG_INTERVAL_MS: "0"
    }
  });
  t.after(() => stack.stop());

  const res = await postAudit(stack, { actor: "Probe", action: "Chain probe", object: "audit-chain", detail: "pre-break" });
  assert.equal(res.status, 200);

  const tampered = await withDb(stack, async (db) => {
    const { rows } = await db.query(
      "SELECT id, detail FROM operations.audit_events WHERE tenant_id = $1 ORDER BY chain_seq LIMIT 1", [TENANT_1]
    );
    await db.query("UPDATE operations.audit_events SET detail = detail || ' [tampered]' WHERE id = $1", [rows[0].id]);
    return rows[0];
  });

  const openAlerts = () => withDb(stack, async (db) => {
    const { rows } = await db.query(
      "SELECT id, status FROM operations.alerts WHERE title = $1 AND status = 'Open'", [CHAIN_ALERT_TITLE]
    );
    return rows;
  });

  // The scheduled verify job must notice the break and raise an alert.
  const deadline = Date.now() + 15000;
  let open = [];
  while (Date.now() < deadline) {
    open = await openAlerts();
    if (open.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(open.length, 1, "chain break must raise exactly one open alert");

  // Dedupe: after several more verify cycles there is still exactly one open alert.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  open = await openAlerts();
  assert.equal(open.length, 1, "repeated verification of a persisting break must not stack alerts");

  // Heal the chain: the next verify cycle must close the alert.
  await withDb(stack, (db) =>
    db.query("UPDATE operations.audit_events SET detail = $1 WHERE id = $2", [tampered.detail, tampered.id])
  );
  const closeDeadline = Date.now() + 15000;
  while (Date.now() < closeDeadline) {
    open = await openAlerts();
    if (open.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(open.length, 0, "healed chain must close the open alert");
});
