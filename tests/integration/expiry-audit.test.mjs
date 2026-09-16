import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT_ID, api, waitFor } from "../helpers/api.mjs";
import { withDb } from "../helpers/db.mjs";
import { startStack } from "../helpers/stack.mjs";

// Audit finding #5: payment-auto-expiry used to UPDATE payments to Cancelled with no
// audit/outbox event — the one state transition invisible to the hash chain. Now it must
// emit one chained audit.event_recorded per expired payment.

test("expired pending-approval payment is auto-cancelled with exactly one chained audit event", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  // 60000 EUR is above the seed approvalThreshold (50000), so the payment stays in
  // 'Pending approval' — exactly the state the expiry handler targets (payment-lifecycle pattern).
  const create = await api(stack.baseUrl, "/payments", {
    method: "POST",
    headers: { "Idempotency-Key": "expiry-audit-1" },
    body: JSON.stringify({ amount: 60000, counterpartyId: "cp-nordic", sourceWalletId: "wal-hold-eur", type: "Supplier" })
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.payment.status, "Pending approval");
  const paymentId = create.data.payment.id;
  const reference = create.data.payment.reference;

  // Age the payment beyond the 72h expiry window, then enqueue the expiry job directly
  // (the scheduler runs hourly; a direct enqueue makes the run deterministic).
  await withDb(stack, async (client) => {
    await client.query(
      "UPDATE payment.payments SET created_at = now() - interval '73 hours' WHERE id = $1",
      [paymentId]
    );
    await client.query(
      `INSERT INTO platform.jobs (id, type, payload, tenant_id, max_attempts, status, attempts)
       VALUES ($1, 'payment-auto-expiry', $2, $3, 1, 'pending', 0)`,
      [randomUUID(), "{}", DEFAULT_TENANT_ID]
    );
  });

  // Poll up to the stack ready timeout: payment Cancelled + our audit row relayed into
  // operations.audit_events (worker polls every 500ms, relay delivers every 500ms).
  // Scoped by reference: the seeded stale payments are also expired at worker startup, so
  // other 'Payment expired' rows exist in the same tenant — each payment still gets exactly one.
  let status = null;
  const auditRows = await waitFor(async () => {
    const state = await api(stack.baseUrl, "/state");
    status = state.data.payments?.find((p) => p.id === paymentId)?.status;
    const rows = await withDb(stack, async (client) => {
      const { rows } = await client.query(
        `SELECT actor, action, object, detail FROM operations.audit_events
         WHERE tenant_id = $1 AND action = 'Payment expired' AND object = $2`,
        [DEFAULT_TENANT_ID, reference]
      );
      return rows;
    });
    return status === "Cancelled" && rows.length >= 1 ? rows : null;
  }, { timeoutMs: 15000, intervalMs: 200, label: `payment ${paymentId} to expire and be audited` });

  assert.equal(status, "Cancelled", "expired payment must be auto-cancelled");

  // The cancel + outbox append share one transaction: the job must COMPLETE (not dead-letter),
  // so the transition is exactly once — cancelled once, audited once, job done.
  const { job_status: jobStatus } = await withDb(stack, async (client) => {
    const { rows } = await client.query(
      "SELECT status AS job_status FROM platform.jobs WHERE type = 'payment-auto-expiry' AND tenant_id = $1 ORDER BY created_at DESC LIMIT 1",
      [DEFAULT_TENANT_ID]
    );
    return rows[0] || { job_status: "missing" };
  });
  assert.equal(jobStatus, "completed", "expiry job must complete cleanly");
  assert.equal(auditRows.length, 1, "expired payment must emit exactly one audit event");
  assert.equal(auditRows[0].actor, "System");
  assert.equal(auditRows[0].action, "Payment expired");
  assert.equal(auditRows[0].object, reference, "audit object must be the payment reference");
  assert.equal(auditRows[0].detail, "Auto-cancelled after 72h");
});
