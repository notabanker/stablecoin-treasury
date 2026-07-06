export const serviceUrls = {
  wallet: process.env.WALLET_SERVICE_URL || "http://127.0.0.1:4101",
  policy: process.env.POLICY_SERVICE_URL || "http://127.0.0.1:4102",
  compliance: process.env.COMPLIANCE_SERVICE_URL || "http://127.0.0.1:4103",
  payment: process.env.PAYMENT_SERVICE_URL || "http://127.0.0.1:4104",
  accounting: process.env.ACCOUNTING_SERVICE_URL || "http://127.0.0.1:4105",
  reconciliation: process.env.RECONCILIATION_SERVICE_URL || "http://127.0.0.1:4106",
  operations: process.env.OPERATIONS_SERVICE_URL || "http://127.0.0.1:4107"
};

const defaultTimeoutMs = Number(process.env.SERVICE_TIMEOUT_MS || 2500);
const defaultRetries = Number(process.env.SERVICE_RETRIES || 2);

// Options that configure this client's own behavior, not fetch() -- must never be spread into
// the fetch init object.
const CLIENT_ONLY_OPTION_KEYS = ["retryable", "idempotencyKey", "tenantId", "timeoutMs", "requestId", "actingUser"];

export async function serviceGet(service, path, options = {}) {
  return serviceRequest(service, path, { method: "GET", retryable: true, ...options });
}

export async function servicePost(service, path, body = {}, options = {}) {
  return serviceRequest(service, path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    ...options
  });
}

export async function serviceRequest(service, path, options) {
  const baseUrl = serviceUrls[service];
  if (!baseUrl) {
    throw new Error(`Unknown service ${service}`);
  }
  const attempts = options.retryable ? defaultRetries + 1 : 1;
  const fetchInit = fetchInitFrom(options);
  let lastError;

  // Internal service auth: sign every outgoing call with the shared internal token
  // when configured. Acting user context is always sent alongside if provided.
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
  const actingUserStr = options.actingUser ? JSON.stringify(options.actingUser) : "";
  let internalSig = {};
  if (internalToken) {
    const { createHmac } = await import("node:crypto");
    const payload = `${options.method || "GET"}|${path}|${fetchInit.body || "{}"}|${actingUserStr}`;
    const sig = createHmac("sha256", internalToken).update(payload).digest("hex");
    internalSig = { "X-Internal-Signature": sig };
  }
  if (actingUserStr) {
    internalSig["X-Acting-User"] = actingUserStr;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs || defaultTimeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...fetchInit,
        signal: controller.signal,
        headers: {
          "X-Request-Id": options.requestId || Math.random().toString(36).slice(2, 12),
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          ...(options.tenantId ? { "X-Tenant-Id": options.tenantId } : {}),
          ...internalSig,
          ...(options.headers || {})
        }
      });
      // The timeout must stay armed through the body read: clearing it right after headers
      // arrive leaves a stalled response body able to hang the caller indefinitely.
      const text = await response.text();
      clearTimeout(timeout);
      const data = parseJsonOrNull(text);
      if (data === PARSE_FAILED) {
        if (response.ok) {
          const error = new Error(`${service} returned a non-JSON response body`);
          error.status = 502;
          error.code = "invalid_upstream_response";
          error.body = { error: "invalid_upstream_response", service };
          if (attempt < attempts && options.retryable) {
            await backoff(attempt);
            continue;
          }
          throw error;
        }
        const error = new Error(`${service} request failed with status ${response.status}`);
        error.status = response.status;
        error.body = null;
        if (shouldRetry(error.status) && attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        throw error;
      }
      if (!response.ok) {
        const error = new Error(data?.message || `${service} request failed`);
        error.status = response.status;
        error.body = data;
        // http.mjs's error handler serializes the original httpError() code into body.error --
        // without copying it here, every error that passes through a service-to-service call
        // (e.g. the gateway forwarding a payment-service rejection) loses its specific code and
        // falls back to a generic "internal_error" at the next hop's error handler.
        error.code = data?.error;
        if (shouldRetry(error.status) && attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      clearTimeout(timeout);
      lastError = normalizeError(service, error, timedOut);
      if (!options.retryable || attempt >= attempts || !isRetryableError(lastError)) {
        throw lastError;
      }
      await backoff(attempt);
    }
  }
  throw lastError;
}

const PARSE_FAILED = Symbol("parse_failed");

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILED;
  }
}

function fetchInitFrom(options) {
  const init = { ...options };
  for (const key of CLIENT_ONLY_OPTION_KEYS) {
    delete init[key];
  }
  return init;
}

function shouldRetry(status) {
  return [408, 429, 502, 503, 504].includes(status);
}

function isRetryableError(error) {
  return error.name === "AbortError" || shouldRetry(error.status);
}

function normalizeError(service, error, timedOut = false) {
  if (timedOut || error.name === "AbortError") {
    const timeout = new Error(`${service} request timed out`);
    timeout.name = "AbortError";
    timeout.status = 504;
    timeout.code = "upstream_timeout";
    timeout.body = { error: "upstream_timeout", service };
    return timeout;
  }
  if (!error.status) {
    const upstream = new Error(`${service} request failed: ${error.message}`);
    upstream.status = 502;
    upstream.code = "upstream_unavailable";
    upstream.body = { error: "upstream_unavailable", service };
    return upstream;
  }
  return error;
}

function backoff(attempt) {
  const delayMs = Math.min(250 * 2 ** (attempt - 1), 1000);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
