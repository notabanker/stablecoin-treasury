import { claimJobs, completeJob, failJob } from "../../../packages/shared/jobs.mjs";
import { logError } from "../../../packages/shared/log.mjs";
import { startWorker } from "../../../packages/shared/worker.mjs";

const BATCH_LIMIT = 5;
const WORKER_ID = `worker-${Math.random().toString(36).slice(2, 10)}`;

export function startJobQueue({ handlers, counters, metrics, pollIntervalMs }) {
  const worker = startWorker({
    name: "job-worker",
    eventPrefix: "job_worker",
    port: Number(process.env.PORT || 9102),
    pollIntervalMs,
    counters,
    metrics
  });

  worker
    .run(async () => {
      const jobs = await claimJobs(WORKER_ID, BATCH_LIMIT);
      counters.claimed += jobs.length;
      for (const job of jobs) {
        await runJob(job, handlers, counters);
      }
      return jobs.length;
    })
    .catch((error) => logError("job_worker_fatal", error));
}

async function runJob(job, handlers, counters) {
  const startedAt = Date.now();
  const handler = handlers[job.type];
  if (!handler) {
    counters.noHandler++;
    logError("job_no_handler", new Error(`Unknown job type: ${job.type}`), { jobId: job.id, type: job.type });
    await failJob(job.id, `Unknown job type: ${job.type}`, { maxAttempts: job.max_attempts });
    return;
  }

  try {
    await handler(job);
    counters.completed++;
    await completeJob(job.id, { attemptNo: job.attempts, durationMs: Date.now() - startedAt });
  } catch (error) {
    counters.failed++;
    if (job.attempts >= job.max_attempts) counters.deadLettered++;
    logError("job_failed", error, { jobId: job.id, type: job.type });
    await failJob(job.id, error.message, { maxAttempts: job.max_attempts });
  }
}
