import { DEFAULT_TENANT_ID } from "./tenant.mjs";
import { query, withTransaction } from "./db.mjs";
import { appendOutboxEvents } from "./outbox.mjs";

const JDB = "platform";

export async function enqueueJob(type, payload, { delayMs = 0, maxAttempts = 5, tenantId = DEFAULT_TENANT_ID } = {}) {
  const runAt = new Date(Date.now() + delayMs).toISOString();
  const { rows } = await query(
    JDB,
    `INSERT INTO platform.jobs (tenant_id, type, payload, status, run_at, max_attempts)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     RETURNING *`,
    [tenantId, type, JSON.stringify(payload), runAt, maxAttempts]
  );
  return rows[0];
}

export async function enqueueJobInTx(client, type, payload, { delayMs = 0, maxAttempts = 5, tenantId = DEFAULT_TENANT_ID } = {}) {
  const runAt = new Date(Date.now() + delayMs).toISOString();
  const { rows } = await client.query(
    `INSERT INTO platform.jobs (tenant_id, type, payload, status, run_at, max_attempts)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     RETURNING *`,
    [tenantId, type, JSON.stringify(payload), runAt, maxAttempts]
  );
  return rows[0];
}

// Poll-and-lock the next batch of due jobs. Each call picks up to limit rows that are pending
// (or retryable failed) and due, atomically incrementing the attempt counter, marking them
// 'running' and setting locked_by so no other worker picks them up.
export async function claimJobs(workerId, limit = 10) {
  return withTransaction(JDB, async (client) => {
    const { rows } = await client.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts = attempts + 1, locked_by = $1
       WHERE id IN (
         SELECT id FROM platform.jobs
         WHERE status IN ('pending', 'failed')
           AND run_at <= now()
         ORDER BY run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [workerId, limit]
    );
    for (const job of rows) {
      await client.query(
        "INSERT INTO platform.job_attempts (job_id, attempt_no, outcome) VALUES ($1, $2, 'started')",
        [job.id, job.attempts]
      );
    }
    return rows.map((row) => ({
      ...row,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    }));
  });
}

export async function completeJob(jobId, { attemptNo = 0, durationMs = 0 } = {}) {
  await query(
    JDB,
    `UPDATE platform.jobs SET status = 'completed', completed_at = now(), locked_by = NULL WHERE id = $1`,
    [jobId]
  );
  await query(
    JDB,
    "INSERT INTO platform.job_attempts (job_id, attempt_no, outcome, duration_ms) VALUES ($1, $2, 'success', $3)",
    [jobId, attemptNo, durationMs]
  );
}

export async function failJob(jobId, error, { maxAttempts = 5 } = {}) {
  return withTransaction(JDB, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM platform.jobs WHERE id = $1 FOR UPDATE",
      [jobId]
    );
    if (!rows[0]) return null;
    const job = rows[0];
    const nextAttempt = job.attempts + 1;
    if (nextAttempt >= maxAttempts) {
      await client.query(
        "UPDATE platform.jobs SET status = 'dead_lettered', last_error = $1, attempts = $2, locked_by = NULL WHERE id = $3",
        [error, nextAttempt, jobId]
      );
      await client.query(
        "INSERT INTO platform.job_attempts (job_id, attempt_no, outcome, error) VALUES ($1, $2, 'dead_lettered', $3)",
        [jobId, nextAttempt, error]
      );
      // Emit an alert for operator visibility — dead-lettered jobs require manual intervention.
      const payload = job.payload && typeof job.payload === "string" ? JSON.parse(job.payload) : (job.payload || {});
      await appendOutboxEvents(client, [{
        tenantId: job.tenant_id,
        aggregateType: "job",
        aggregateId: job.id,
        eventType: "operations.alert_created",
        payload: {
          severity: "High",
          title: `Job dead-lettered: ${job.type}`,
          detail: `Job ${job.id} (type: ${job.type}) exhausted ${maxAttempts} attempts. Last error: ${error}. Payment: ${payload.paymentId || "N/A"}`
        }
      }]);
    } else {
      const backoff = Math.min(250 * 2 ** nextAttempt, 60000);
      const runAt = new Date(Date.now() + backoff).toISOString();
      await client.query(
        "UPDATE platform.jobs SET status = 'failed', last_error = $1, attempts = $2, run_at = $3, locked_by = NULL WHERE id = $4",
        [error, nextAttempt, runAt, jobId]
      );
      await client.query(
        "INSERT INTO platform.job_attempts (job_id, attempt_no, outcome, error) VALUES ($1, $2, 'error', $3)",
        [jobId, nextAttempt, error]
      );
    }
    return job;
  });
}
