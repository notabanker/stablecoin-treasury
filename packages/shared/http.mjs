import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { createServer } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { runWithTenant } from "./db.mjs";
import { tenantIdFromHeaders } from "./tenant.mjs";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function createJsonService({ name, port, routes, staticRoot, internalAuthRequired = false, rateLimit = !internalAuthRequired, extraMetrics } = {}) {
  const host = process.env.HOST || "127.0.0.1";
  const metrics = createMetrics(name);
  const limiter = createRateLimiter();
  const registeredRoutes = internalAuthRequired ? routes.map(requireInternalAuth) : routes;
  let draining = false;

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const requestId = req.headers["x-request-id"] || randomUUID();
    setBaseHeaders(res, requestId);
    const finish = (status) => {
      metrics.record(status, Date.now() - started);
      logRequest(name, req.method, req.url, status, Date.now() - started, requestId);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return finish(204);
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      if (path === "/metrics" && req.method === "GET") {
        const snapshot = metrics.snapshot();
        if (extraMetrics) Object.assign(snapshot, await extraMetrics());
        sendJson(res, 200, snapshot);
        return; // Scrapes are not request traffic: no counter/log entry.
      }

      if (draining && path !== "/health") {
        sendJson(res, 503, { error: "service_draining", service: name });
        return finish(503);
      }

      // Health checks never consume rate-limit tokens; /api/state has its own tighter budget.
      if (rateLimit && path !== "/health") {
        const isStateRoute = path === "/api/state";
        const rate = limiter.check(req, isStateRoute ? "state" : "general", isStateRoute ? STATE_RATE_MAX : RATE_MAX);
        if (!rate.allowed) {
          res.setHeader("Retry-After", Math.ceil(rate.retryAfterMs / 1000));
          sendJson(res, 429, { error: "rate_limited", message: "Too many requests", retryAfterMs: rate.retryAfterMs });
          return finish(429);
        }
      }

      const matched = matchRoute(registeredRoutes, req.method, path);
      if (matched) {
        const status = await dispatch(matched, req, res, url, requestId);
        return finish(status);
      }

      if (staticRoot && req.method === "GET" && await serveStatic(staticRoot, path, res)) {
        return finish(200);
      }

      sendJson(res, 404, { error: "not_found", service: name, path });
      return finish(404);
    } catch (error) {
      const status = error.status || 500;
      if (!res.headersSent) {
        sendJson(res, status, { error: error.code || "internal_error", message: error.message, service: name });
      }
      return finish(status);
    }
  });

  // headersTimeout must stay below requestTimeout: headers are a prefix of the whole request,
  // so they must always arrive first and faster.
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

// Dispatch a matched route and return the response status for metrics/logging.
async function dispatch(matched, req, res, url, requestId) {
  const { body, rawBody } = await readJson(req);
  const context = {
    body,
    rawBody,
    headers: req.headers,
    method: req.method,
    params: matched.params,
    query: Object.fromEntries(url.searchParams),
    requestId,
    url,
    clientIp: getClientIp(req),
    // Malformed JSON in the acting-user header is treated as absent: an unauthenticated
    // caller must not be able to pick our error status code by sending garbage.
    actingUser: parseActingUser(req.headers["x-acting-user"])
  };
  // Enter the tenant context for RLS: db.mjs picks this up and sets the transaction-local
  // app.tenant_id that row-level security policies check. Missing header -> default tenant
  // (or 400 when TENANT_HEADER_REQUIRED and non-public); invalid UUID -> 400 (fail closed).
  // Public routes (health/ready) never require a tenant header so probes stay header-free.
  const tenantRequired = process.env.TENANT_HEADER_REQUIRED === "true" && !matched.public;
  const result = await runWithTenant(
    tenantIdFromHeaders(req.headers, { required: tenantRequired }),
    () => matched.handler(context)
  );
  // Route handlers can set cookies by returning a `cookies` array of Set-Cookie strings.
  if (result?.cookies?.length) {
    res.setHeader("Set-Cookie", [...result.cookies]);
  }
  sendJson(res, result?.status || 200, result?.body ?? result);
  return result?.status || 200;
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
// In dev mode (default) the wrapper is transparent and the acting user is trusted as-is.
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "dev-internal-token";
const INTERNAL_AUTH_REQUIRED = process.env.INTERNAL_AUTH_REQUIRED === "true";

export function signInternalRequest(method, path, body, actingUser = "") {
  const actingUserStr = typeof actingUser === "string" ? actingUser : JSON.stringify(actingUser || {});
  const payload = `${method}|${path}|${JSON.stringify(body || {})}|${actingUserStr}`;
  const signature = createHmac("sha256", INTERNAL_SERVICE_TOKEN).update(payload).digest("hex");
  return { "X-Internal-Signature": signature, "X-Acting-User": actingUserStr };
}

function validateInternalAuth(routeHandler) {
  return async (context) => {
    if (!INTERNAL_AUTH_REQUIRED) return routeHandler(context);

    const signature = context.headers["x-internal-signature"] || "";
    const actingUserHeader = context.headers["x-acting-user"] || "";
    const valid = verifyInternalRequest(context.method, context.url?.pathname || "/", context.body, signature, actingUserHeader);
    if (!valid) {
      throw httpError(401, "Internal authentication required", "internal_auth_required");
    }
    context.actingUser = parseActingUser(actingUserHeader);
    return routeHandler(context);
  };
}

function requireInternalAuth(routeDef) {
  return routeDef.public ? routeDef : { ...routeDef, handler: validateInternalAuth(routeDef.handler) };
}

function verifyInternalRequest(method, path, body, signature, actingUserHeader = "") {
  const payload = `${method}|${path}|${JSON.stringify(body || {})}|${actingUserHeader || ""}`;
  const expected = createHmac("sha256", INTERNAL_SERVICE_TOKEN).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(String(signature || ""), "hex");
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

function parseActingUser(header) {
  if (!header) return null;
  try {
    return JSON.parse(header);
  } catch {
    return null;
  }
}

async function readJson(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) {
    return { body: {}, rawBody: "" };
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
  // rawBody carries the exact request bytes (untrimmed) for signature verification over the
  // raw body; body is the parsed JSON.
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const bodyText = rawBody.trim();
  if (!bodyText) {
    return { body: {}, rawBody: "" };
  }
  try {
    return { body: JSON.parse(bodyText), rawBody };
  } catch {
    throw httpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

function matchRoute(routes, method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const params = matchPath(candidate.pattern, pathname);
    if (params) return { ...candidate, params };
  }
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
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
    res.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
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
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
  res.setHeader("X-Request-Id", requestId);
  // Trace propagation: pass the request-id as the trace-id for simplicity.
  // A production OTel SDK would replace this with proper traceparent header handling.
  res.setHeader("X-Trace-Id", requestId);
}

function logRequest(name, method, path, status, durationMs, requestId) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: name, method, path, status, durationMs, requestId }));
}

// Proxy-aware client IP extraction: use socket address by default.
// Set TRUST_PROXY_HEADERS=true to honor X-Forwarded-For from trusted proxies.
function getClientIp(req) {
  if (process.env.TRUST_PROXY_HEADERS === "true" && req.headers["x-forwarded-for"]) {
    return stripV4Mapped(req.headers["x-forwarded-for"].split(",")[0].trim());
  }
  return stripV4Mapped(req.socket?.remoteAddress || "127.0.0.1");
}

function stripV4Mapped(ip) {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

// Sliding-window counters per (ip, bucket). In production this would be a Redis-backed
// distributed counter; for single-process services an in-memory Map is correct because each
// service only serves one port.
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 1000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 200);
const STATE_RATE_MAX = Number(process.env.STATE_RATE_LIMIT_MAX || 50);

function createRateLimiter() {
  const buckets = new Map();
  let cleanupTimer = null;

  function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      if (buckets.size === 0) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    }, Math.max(RATE_WINDOW_MS, 10000));
    cleanupTimer.unref();
  }

  return {
    check(req, bucketName, limit) {
      const key = `${bucketName}:${getClientIp(req)}`;
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { tokens: limit, resetAt: now + RATE_WINDOW_MS };
        buckets.set(key, bucket);
        scheduleCleanup();
      }
      if (bucket.tokens <= 0) {
        return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
      }
      bucket.tokens -= 1;
      return { allowed: true };
    }
  };
}

function createMetrics(service) {
  const startedAt = new Date().toISOString();
  const counters = { requests: 0, status2xx: 0, status4xx: 0, status5xx: 0, totalDurationMs: 0 };
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
