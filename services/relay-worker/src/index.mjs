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
const metrics = { published: 0, failed: 0, noRoute: 0 };
const startedAt = new Date().toISOString();

// Money-path metrics cache: DB queries are run at most once per METRICS_CACHE_MS.
const METRICS_CACHE_MS = 5000;
let metricsCache = { timestamp: 0, unpublishedCount: 0, outboxLagMs: 0 };

async function refreshMetricsCache() {
  const now = Date.now();
  if (now - metricsCache.timestamp < METRICS_CACHE_MS) return;
  try {
    const { rows } = await query(DB,
      "SELECT COUNT(*)::int AS unpublished_count, COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)) * 1000, 0)::float AS outbox_lag_ms FROM platform.outbox_events WHERE published_at IS NULL"
    );
    metricsCache = {
      timestamp: now,
      unpublishedCount: rows[0]?.unpublished_count ?? 0,
      outboxLagMs: Math.round(rows[0]?.outbox_lag_ms ?? 0)
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
      unpublishedCount: metricsCache.unpublishedCount,
      outboxLagMs: metricsCache.outboxLagMs
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
      await recordDeliveryAttempt(row.id);
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
       WHERE published_at IS NULL
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

async function recordDeliveryAttempt(eventId) {
  // Delivery attempts intentionally leave published_at NULL. The relay only marks an event
  // published after the consumer accepts it. If this process dies between claim and delivery,
  // the next poll can safely pick the event up again; consumer inbox rows make duplicate
  // delivery exactly-once at the effect level.
  await query(DB, "UPDATE platform.outbox_events SET published_at = NULL WHERE id = $1", [eventId]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  running = false;
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "relay_shutdown" }));
  setTimeout(() => process.exit(0), 500);
}
