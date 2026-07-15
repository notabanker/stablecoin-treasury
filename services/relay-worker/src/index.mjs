import { createServer } from "node:http";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { servicePost } from "../../../packages/shared/service-client.mjs";
import { EVENT_ROUTES } from "../../../packages/shared/outbox.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";

const DB = "platform";
const POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_INTERVAL_MS || 500);
const MAX_RETRIES = Number(process.env.RELAY_MAX_RETRIES || 5);
const BATCH_SIZE = 20;
let running = true;

validateProductionConfig("relay-worker");
const metrics = { published: 0, failed: 0, noRoute: 0, deadLettered: 0 };
const startedAt = new Date().toISOString();

// Money-path metrics cache: DB queries are run at most once per METRICS_CACHE_MS.
const METRICS_CACHE_MS = 5000;
let metricsCache = { timestamp: 0, unpublishedCount: 0, outboxLagMs: 0, deadLetterCount: 0 };

async function refreshMetricsCache() {
  const now = Date.now();
  if (now - metricsCache.timestamp < METRICS_CACHE_MS) return;
  try {
    const { rows } = await query(DB,
      `SELECT
         COUNT(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS unpublished_count,
         COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_letter_count,
         COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)) * 1000, 0)::float AS outbox_lag_ms
       FROM platform.outbox_events WHERE published_at IS NULL OR dead_lettered_at IS NOT NULL`
    );
    metricsCache = {
      timestamp: now,
      unpublishedCount: rows[0]?.unpublished_count ?? 0,
      outboxLagMs: Math.round(rows[0]?.outbox_lag_ms ?? 0),
      deadLetterCount: rows[0]?.dead_letter_count ?? 0
    };
  } catch {
    // stale cache is better than a broken metrics endpoint
  }
}

const healthPort = Number(process.env.PORT || 9101);
const healthServer = createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  if (req.url === "/metrics") {
    await refreshMetricsCache();
    res.end(JSON.stringify({
      status: "ok",
      service: "relay-worker",
      startedAt,
      published: metrics.published,
      failed: metrics.failed,
      noRoute: metrics.noRoute,
      deadLettered: metrics.deadLettered,
      unpublishedCount: metricsCache.unpublishedCount,
      outboxLagMs: metricsCache.outboxLagMs,
      deadLetterCount: metricsCache.deadLetterCount
    }));
  } else {
    res.end(JSON.stringify({ status: "ok", service: "relay-worker" }));
  }
});
healthServer.listen(healthPort, "127.0.0.1");
healthServer.unref();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(JSON.stringify({ at: new Date().toISOString(), event: "relay_started" }));

while (running) {
  try {
    const dispatched = await pollAndDispatch();
    if (dispatched === 0) {
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "relay_cycle_error",
      message: error.message
    }));
    await sleep(Math.min(POLL_INTERVAL_MS * 4, 5000));
  }
}

async function pollAndDispatch() {
  const rows = await getUnpublishedEvents();
  if (rows.length === 0) return 0;

  for (const row of rows) {
    const route = EVENT_ROUTES[row.event_type];
      if (!route) {
      await markPublished(row.id);
      metrics.noRoute++;
      console.warn(JSON.stringify({
        at: new Date().toISOString(),
        event: "relay_no_route",
        event_type: row.event_type,
        event_id: row.id
      }));
      continue;
    }

    try {
      await servicePost(route.consumer, route.path, row.payload, {
        headers: { "X-Event-Id": row.id, "X-Event-Type": row.event_type },
        tenantId: row.tenant_id,
        actingUser: { id: "system:worker", display: "System" },
        timeoutMs: Number(process.env.RELAY_DELIVERY_TIMEOUT_MS || 5000),
        requestId: `relay-${row.id}`
      });
      await markPublished(row.id);
      metrics.published++;
    } catch (error) {
      const deadLettered = await recordDeliveryAttempt(row.id, error.message);
      if (deadLettered) metrics.deadLettered++;
      metrics.failed++;
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        event: "relay_delivery_failed",
        event_id: row.id,
        event_type: row.event_type,
        consumer: route.consumer,
        message: error.message
      }));
    }
  }
  return rows.length;
}

async function getUnpublishedEvents() {
  return withTransaction(DB, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM platform.outbox_events
       WHERE published_at IS NULL AND dead_lettered_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE]
    );
    return rows;
  });
}

async function markPublished(eventId) {
  await query(DB, "UPDATE platform.outbox_events SET published_at = now() WHERE id = $1", [eventId]);
}

// Delivery attempts intentionally leave published_at NULL: the relay only marks an event
// published after the consumer accepts it. If this process dies between claim and delivery, the
// next poll can safely pick the event up again (consumer inbox rows make duplicate delivery
// exactly-once at the effect level) -- unless attempts has now reached MAX_RETRIES, in which case
// the event is dead-lettered so it stops occupying a batch slot every cycle. Below that, the next
// attempt is scheduled with exponential backoff (mirrors platform.jobs' failJob: 250ms base,
// doubling, capped at 60s) so a struggling consumer isn't hammered every poll cycle. Returns true
// when this call dead-lettered the event, so the caller can update its own metrics.
async function recordDeliveryAttempt(eventId, errorMessage) {
  const { rows } = await query(DB,
    `UPDATE platform.outbox_events
     SET attempts = attempts + 1,
         last_error = $2,
         dead_lettered_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE dead_lettered_at END,
         next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN next_attempt_at
                                 ELSE now() + (LEAST(250 * POWER(2, attempts + 1), 60000) || ' milliseconds')::interval END
     WHERE id = $1
     RETURNING attempts, dead_lettered_at, next_attempt_at`,
    [eventId, errorMessage, MAX_RETRIES]
  );
  const deadLettered = Boolean(rows[0]?.dead_lettered_at);
  if (deadLettered) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "relay_dead_lettered",
      event_id: eventId,
      attempts: rows[0].attempts
    }));
  }
  return deadLettered;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  running = false;
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "relay_shutdown" }));
  setTimeout(() => process.exit(0), 500);
}
