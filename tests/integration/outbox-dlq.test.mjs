import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// Short-lived connection per call, not one held open across the polling window: a long-lived
// probe connection races with the disposable stack's teardown (pg_terminate_backend on stop)
// and, worse, with nothing else touching this DB, can itself intermittently receive a server-side
// termination while idle between polls. Mirrors the fix already applied to the tenant-2 reset
// test in auth-rbac.test.mjs (0.1.2 session).
async function withDb(connectionString, fn) {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function insertOutboxEvent(connectionString, { tenantId = DEFAULT_TENANT_ID, eventType, payload }) {
  return withDb(connectionString, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO platform.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'test-probe', 'probe', $2, $3)
       RETURNING id`,
      [tenantId, eventType, JSON.stringify(payload)]
    );
    return rows[0].id;
  });
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// V8 Task 0.2.5 (audit finding H3): before this fix, recordDeliveryAttempt was a no-op and
// getUnpublishedEvents had no way to exclude a permanently-failing event, so BATCH_SIZE (20)
// poisoned events would occupy every poll's LIMIT 20 forever and starve delivery for everyone.
// This reproduces exactly that: 20 events that fail on every attempt (operations.alerts.title
// is NOT NULL, so an alert_created payload missing "title" 500s deterministically), followed by
// good events that must still be delivered once the poison batch dead-letters and frees the
// poll window.
test("outbox delivery survives a poisoned batch: dead-lettering frees the queue for good events", async (t) => {
  const stack = await startStack({ extraEnv: { RELAY_MAX_RETRIES: "1" } });
  t.after(() => stack.stop());
  const db = stack._env.DATABASE_URL;

  const poisonIds = [];
  for (let i = 0; i < 20; i += 1) {
    poisonIds.push(await insertOutboxEvent(db, {
      eventType: "operations.alert_created",
      payload: { severity: "Medium" } // missing required "title" -> operations /alerts 500s every attempt
    }));
  }
  const goodIds = [];
  for (let i = 0; i < 3; i += 1) {
    goodIds.push(await insertOutboxEvent(db, {
      eventType: "operations.alert_created",
      payload: { severity: "Low", title: `outbox-dlq-good-${i}` }
    }));
  }

  // All 20 poison events must dead-letter (not retry forever, not silently drop).
  const poisonRows = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query(
      "SELECT id, attempts, dead_lettered_at, last_error FROM platform.outbox_events WHERE id = ANY($1)",
      [poisonIds]
    );
    return rows.every((row) => row.dead_lettered_at) ? rows : null;
  }));
  for (const row of poisonRows) {
    assert.equal(row.attempts, 1, "poison event must dead-letter after RELAY_MAX_RETRIES=1 attempt, not retry forever");
    assert.ok(row.last_error, "dead-lettered event must record last_error for the ops runbook");
  }

  // The good events sit behind 20 poison events in created_at order. Under the pre-fix code
  // (no dead-letter exclusion, BATCH_SIZE=20) they would never be selected by
  // "ORDER BY created_at LIMIT 20" and would never be delivered.
  const goodRows = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query(
      "SELECT id, published_at FROM platform.outbox_events WHERE id = ANY($1)",
      [goodIds]
    );
    return rows.every((row) => row.published_at) ? rows : null;
  }));
  assert.equal(goodRows.length, 3);

  // Dead-lettered events must not be retried again once excluded from the poll set.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await withDb(db, async (client) => {
    const { rows: recheck } = await client.query(
      "SELECT attempts FROM platform.outbox_events WHERE id = ANY($1)",
      [poisonIds]
    );
    for (const row of recheck) {
      assert.equal(row.attempts, 1, "dead-lettered events must stop accumulating attempts");
    }
  });

  // The watchdog's outbox DLQ check must see the dead-lettered rows.
  await withDb(db, async (client) => {
    const { rows: dlqCount } = await client.query(
      "SELECT COUNT(*)::int AS count FROM platform.outbox_events WHERE dead_lettered_at IS NOT NULL"
    );
    assert.equal(dlqCount[0].count, 20);
  });
});

// V8 Task 0.2.2: a failing-but-not-yet-dead-lettered event must back off, not get re-attempted
// on every single poll cycle. With RELAY_MAX_RETRIES=3 the poison event survives its first
// failure without dead-lettering, so next_attempt_at must be scheduled into the future.
test("a failing event that has not yet exhausted retries schedules backoff instead of retrying immediately", async (t) => {
  const stack = await startStack({ extraEnv: { RELAY_MAX_RETRIES: "3" } });
  t.after(() => stack.stop());
  const db = stack._env.DATABASE_URL;

  const poisonId = await insertOutboxEvent(db, {
    eventType: "operations.alert_created",
    payload: { severity: "Medium" } // missing required "title" -> 500s every attempt
  });

  const afterFirstAttempt = await waitFor(() => withDb(db, async (client) => {
    const { rows } = await client.query(
      "SELECT attempts, dead_lettered_at, next_attempt_at FROM platform.outbox_events WHERE id = $1",
      [poisonId]
    );
    return rows[0]?.attempts >= 1 ? rows[0] : null;
  }));

  assert.equal(afterFirstAttempt.attempts, 1);
  assert.equal(afterFirstAttempt.dead_lettered_at, null, "must not dead-letter before RELAY_MAX_RETRIES");
  assert.ok(afterFirstAttempt.next_attempt_at, "must schedule a next attempt instead of retrying immediately");
  assert.ok(
    new Date(afterFirstAttempt.next_attempt_at).getTime() > Date.now(),
    "next_attempt_at must be in the future (backoff), not the past"
  );
});
