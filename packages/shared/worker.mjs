import { createServer } from "node:http";
import { logEvent } from "./log.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared runtime for the background workers (relay, job worker): a health/metrics HTTP
// endpoint, graceful shutdown, and the poll loop. `cycle` returns the number of items it
// processed; the loop sleeps only when a cycle found no work.
export function startWorker({ name, eventPrefix = name, port, counters = {}, metrics, pollIntervalMs = 500 }) {
  const startedAt = new Date().toISOString();
  let running = true;

  const server = createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    const body = { status: "ok", service: name };
    if (req.url === "/metrics") {
      Object.assign(body, { startedAt, ...counters }, metrics ? await metrics() : {});
    }
    res.end(JSON.stringify(body));
  });
  server.listen(port, "127.0.0.1");
  server.unref();

  const shutdown = () => {
    running = false;
    logEvent(`${eventPrefix}_shutdown`);
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return {
    stopped: () => !running,
    async run(cycle, { onError } = {}) {
      logEvent(`${eventPrefix}_started`);
      while (running) {
        try {
          const worked = await cycle();
          if (!worked) await sleep(pollIntervalMs);
        } catch (error) {
          if (onError) onError(error);
          else logEvent(`${eventPrefix}_cycle_error`, { message: error.message });
          await sleep(Math.min(pollIntervalMs * 4, 5000));
        }
      }
    }
  };
}
