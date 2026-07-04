import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { createServer } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Rate limiter: simple sliding-window counters per IP keyed by (ip, pathPrefix).
// In production this would be a Redis-backed distributed counter; for single-process
// services an in-memory Map per service instance is correct because each service
// only serves one port and all requests to that port go through this code path.
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 1000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 200);
const STATE_RATE_MAX = Number(process.env.STATE_RATE_LIMIT_MAX || 50);
const rateBuckets = new Map();
let rateCleanupTimer = null;

// Proxy-aware client IP extraction: use socket address by default.
// Set TRUST_PROXY_HEADERS=true to honor X-Forwarded-For from trusted proxies.
function getClientIp(req) {
  const trustProxy = process.env.TRUST_PROXY_HEADERS === "true";
  if (trustProxy && req.headers["x-forwarded-for"]) {
    const fwd = req.headers["x-forwarded-for"].split(",")[0].trim();
    return fwd.startsWith("::ffff:") ? fwd.slice(7) : fwd;
  }
  const remote = req.socket?.remoteAddress || "127.0.0.1";
  return remote.startsWith("::ffff:") ? remote.slice(7) : remote;
}

function checkRateLimit(req, now, windowMs, limit, bucketKey) {
  const ip = getClientIp(req);
  const key = `${bucketKey}:${ip}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { tokens: limit, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
    startRateCleanup();
  }
  if (bucket.tokens <= 0) {
    return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.tokens -= 1;
  return { allowed: true, remaining: bucket.tokens };
}

function startRateCleanup() {
  if (rateCleanupTimer) return;
  rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(key);
    }
    if (rateBuckets.size === 0) {
      clearInterval(rateCleanupTimer);
      rateCleanupTimer = null;
    }
  }, Math.max(RATE_WINDOW_MS, 10000));
  rateCleanupTimer.unref();
}

export function createJsonService({ name, port, routes, staticRoot, internalAuthRequired = false }) {
  const host = process.env.HOST || "127.0.0.1";
  const metrics = createMetrics(name);
  let draining = false;
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const requestId = req.headers["x-request-id"] || cryptoRandomId();
    setBaseHeaders(res, requestId);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      metrics.record(204, Date.now() - started);
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/metrics" && req.method === "GET") {
        sendJson(res, 200, metrics.snapshot());
        return;
      }
      if (draining && url.pathname !== "/health") {
        sendJson(res, 503, { error: "service_draining", service: name });
        metrics.record(503, Date.now() - started);
        logRequest(name, req.method, url.pathname, 503, Date.now() - started, requestId);
        return;
      }

      // Rate limiting: separate buckets for state reads vs general routes.
      // Bypass for health checks so they never consume rate-limit tokens.
      if (url.pathname !== "/health") {
        const isStateRoute = url.pathname === "/api/state";
        const bucketKey = isStateRoute ? "state" : "general";
        const rateLimit = isStateRoute
          ? STATE_RATE_MAX
          : RATE_MAX;
        const rateResult = checkRateLimit(req, Date.now(), RATE_WINDOW_MS, rateLimit, bucketKey);
        if (!rateResult.allowed) {
          res.setHeader("Retry-After", Math.ceil(rateResult.retryAfterMs / 1000));
          sendJson(res, 429, {
            error: "rate_limited",
            message: "Too many requests",
            retryAfterMs: rateResult.retryAfterMs
          });
          metrics.record(429, Date.now() - started);
          logRequest(name, req.method, url.pathname, 429, Date.now() - started, requestId);
          return;
        }
      }

      const route = matchRoute(internalRoutes, req.method, url.pathname);

      if (route) {
        const body = await readJson(req);
        const context = {
          body,
          headers: req.headers,
          method: req.method,
          params: route.params,
          query: Object.fromEntries(url.searchParams),
          requestId,
          url,
          clientIp: getClientIp(req)
        };
        const result = await route.handler(context);
        // Route handlers can set cookies by returning a `cookies` array of Set-Cookie strings.
        if (result?.cookies?.length) {
          res.setHeader("Set-Cookie", [...result.cookies]);
        }
        sendJson(res, result?.status || 200, result?.body ?? result);
        metrics.record(result?.status || 200, Date.now() - started);
        logRequest(name, req.method, url.pathname, result?.status || 200, Date.now() - started, requestId);
        return;
      }

      if (staticRoot && req.method === "GET") {
        const served = await serveStatic(staticRoot, url.pathname, res);
        if (served) {
          metrics.record(200, Date.now() - started);
          logRequest(name, req.method, url.pathname, 200, Date.now() - started, requestId);
          return;
        }
      }

      sendJson(res, 404, { error: "not_found", service: name, path: url.pathname });
      metrics.record(404, Date.now() - started);
      logRequest(name, req.method, url.pathname, 404, Date.now() - started, requestId);
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) {
        sendJson(res, status, {
          error: error.code || "internal_error",
          message: error.message,
          service: name
        });
      }
      metrics.record(status, Date.now() - started);
      logRequest(name, req.method, req.url, status, Date.now() - started, requestId);
    }
  });
  // headersTimeout must stay below requestTimeout: headers are a prefix of the whole request,
  // so they must always arrive first and faster.
  const internalRoutes = internalAuthRequired && INTERNAL_AUTH_REQUIRED
    ? routes.map((rt) => rt.public ? rt : { ...rt, handler: validateInternalAuth(rt.handler) })
    : routes;

  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 8000);
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);

  server.listen(port, host, () => {
    console.log(`${name} listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    draining = true;
    console.log(JSON.stringify({ at: new Date().toISOString(), service: name, event: "shutdown_started" }));
    server.close(() => {
      console.log(JSON.stringify({ at: new Date().toISOString(), service: name, event: "shutdown_complete" }));
      process.exit(0);
    });
    setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000)).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return server;
}

export function route(method, pattern, handler, opts = {}) {
  return { method, pattern, handler, public: opts.public === true };
}

export function ok(body) {
  return { status: 200, body };
}

export function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Internal service authentication. When INTERNAL_AUTH_REQUIRED=true, services validate
// a shared secret via HMAC over (method + path + body). Gateway, relay, and job-worker
// sign their outgoing requests with the same secret and same payload shape.
// Keep local dev ergonomic: defaults to off.
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "dev-internal-token";
const INTERNAL_AUTH_REQUIRED = process.env.INTERNAL_AUTH_REQUIRED === "true";

export function signInternalRequest(method, path, body) {
  const payload = `${method}|${path}|${JSON.stringify(body || {})}`;
  const signature = createHmac("sha256", INTERNAL_SERVICE_TOKEN).update(payload).digest("hex");
  return { "X-Internal-Signature": signature };
}

function verifyInternalRequest(method, path, body, signature) {
  const payload = `${method}|${path}|${JSON.stringify(body || {})}`;
  const expected = createHmac("sha256", INTERNAL_SERVICE_TOKEN).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(String(signature || ""), "hex");
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

export function validateInternalAuth(routeHandler, opts = {}) {
  return async (context) => {
    if (!INTERNAL_AUTH_REQUIRED) return routeHandler(context);
    if (opts.public) return routeHandler(context);

    const sig = context.headers["x-internal-signature"] || "";
    const method = context.method || "GET";
    const path = context.url?.pathname || "/";
    if (!verifyInternalRequest(method, path, context.body, sig)) {
      throw httpError(401, "Internal authentication required", "internal_auth_required");
    }
    return routeHandler(context);
  };
}

async function readJson(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) {
    return {};
  }

  const limitBytes = Number(process.env.HTTP_BODY_LIMIT_BYTES || 1_048_576);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw httpError(413, "Request body is too large", "payload_too_large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw httpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

function matchRoute(routes, method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const params = matchPath(candidate.pattern, pathname);
    if (params) {
      return { ...candidate, params };
    }
  }
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

function serveStatic(root, pathname, res) {
  return new Promise((resolve) => {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const relative = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, relative);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!filePath.startsWith(rootWithSep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      resolve(false);
      return;
    }

    const ext = extname(filePath);
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      // The file existed at statSync-time but failed to read (deleted mid-request, permission
      // change, disk error). Without this handler the unhandled 'error' event on the stream
      // would crash the whole process -- this is the gateway, so that would take the front
      // door down for every service behind it.
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "static_file_read_failed" }));
      } else {
        res.destroy();
      }
      resolve(true);
    });
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream"
    });
    stream.pipe(res);
    stream.on("end", () => resolve(true));
  });
}

function sendJson(res, status, body) {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function setBaseHeaders(res, requestId) {
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, idempotency-key, x-request-id, x-csrf-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Request-Id", requestId);
  // Trace propagation: pass the request-id as the trace-id for simplicity.
  // A production OTel SDK would replace this with proper traceparent header handling.
  res.setHeader("X-Trace-Id", requestId);
}

function logRequest(name, method, path, status, durationMs, requestId) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: name, method, path, status, durationMs, requestId }));
}

function cryptoRandomId() {
  return randomUUID();
}

function createMetrics(service) {
  const startedAt = new Date().toISOString();
  const counters = {
    requests: 0,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
    totalDurationMs: 0
  };
  return {
    record(status, durationMs) {
      counters.requests += 1;
      counters.totalDurationMs += durationMs;
      if (status >= 500) counters.status5xx += 1;
      else if (status >= 400) counters.status4xx += 1;
      else if (status >= 200) counters.status2xx += 1;
    },
    snapshot() {
      return {
        service,
        startedAt,
        ...counters,
        averageDurationMs: counters.requests ? Math.round(counters.totalDurationMs / counters.requests) : 0
      };
    }
  };
}
