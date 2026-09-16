import { query } from "../../../../packages/shared/db.mjs";
import { getActiveTenants } from "../active-tenants.mjs";

const STUCK_EXECUTING_MS = Number(process.env.WATCHDOG_STUCK_EXECUTING_MS || 300000); // 5 minutes
const OUTBOX_LAG_MS = Number(process.env.WATCHDOG_OUTBOX_LAG_MS || 60000); // 1 minute
const PENDING_JOB_AGE_MS = Number(process.env.WATCHDOG_PENDING_JOB_AGE_MS || 300000); // 5 minutes

// Each check reads one scalar (`value`) and raises an alert when value > threshold. The
// outbox/job checks are platform-wide; only the stuck-payment check is tenant-scoped.
const CHECKS = [
  {
    type: "stuck_executing_payments",
    title: "Stuck Executing payments",
    threshold: 0,
    db: "payment",
    sql: `SELECT COUNT(*)::int AS value
            FROM payment.payments
           WHERE status = 'Executing'
             AND tenant_id = $1
             AND created_at < now() - ($2 || ' ms')::interval`,
    params: (tenantId) => [tenantId, String(STUCK_EXECUTING_MS)]
  },
  {
    type: "outbox_lag",
    title: "Outbox lag exceeded",
    threshold: OUTBOX_LAG_MS,
    db: "platform",
    sql: `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS value
            FROM platform.outbox_events WHERE published_at IS NULL`
  },
  {
    type: "dead_letter_queue",
    title: "Dead-letter queue non-empty",
    threshold: 0,
    db: "platform",
    sql: "SELECT COUNT(*)::int AS value FROM platform.jobs WHERE status = 'dead_lettered'"
  },
  {
    type: "outbox_dead_letter_queue",
    title: "Outbox dead-letter queue non-empty",
    threshold: 0,
    db: "platform",
    sql: "SELECT COUNT(*)::int AS value FROM platform.outbox_events WHERE dead_lettered_at IS NOT NULL"
  },
  {
    type: "pending_job_age",
    title: "Pending job age exceeded",
    threshold: PENDING_JOB_AGE_MS,
    db: "platform",
    sql: `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS value
            FROM platform.jobs WHERE status = 'pending'`
  }
];

export async function runWatchdog() {
  for (const tenantId of await getActiveTenants()) {
    for (const check of CHECKS) {
      const { rows } = await query(check.db, check.sql, check.params ? check.params(tenantId) : []);
      await evaluateCheck(tenantId, check, Math.round(rows[0]?.value || 0));
    }
  }
}

async function evaluateCheck(tenantId, check, count) {
  const { rows: existing } = await query("operations",
    "SELECT status FROM operations.alerts WHERE tenant_id = $1 AND title = $2 ORDER BY created_at DESC LIMIT 1",
    [tenantId, check.title]
  );
  const isOpen = existing[0]?.status === "Open";

  if (count > check.threshold) {
    if (isOpen) return; // One open alert per check type; re-alert only after it is closed.
    await query("operations",
      `INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status)
       VALUES ($1, $2, $3, $4, $5, 'Open')`,
      [`wd-${check.type}-${Date.now().toString(36)}`, tenantId, "High", check.title, `${check.type}: ${count} > ${check.threshold}`]
    );
    return;
  }

  if (isOpen) {
    // Condition cleared: close the open alert(s) of this type.
    await query("operations",
      "UPDATE operations.alerts SET status = 'Closed' WHERE tenant_id = $1 AND title = $2 AND status = 'Open'",
      [tenantId, check.title]
    );
  }
}
