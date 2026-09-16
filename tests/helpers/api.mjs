// Shared HTTP helpers for integration tests. These replace near-identical per-file copies of
// api(), fetchRaw(), extractCookie(), login() and polling helpers.

export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const TENANT_2_ID = "00000000-0000-0000-0000-000000000002";
export const DEMO_PASSWORD = "demo123";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// JSON request against the gateway's /api surface.
export async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    redirect: "manual",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie?.() || []
  };
}

export function extractCookie(cookies, name) {
  for (const prefix of [`${name}=`, `__Host-${name}=`]) {
    for (const cookie of cookies) {
      if (cookie.startsWith(prefix)) return cookie.slice(prefix.length).split(";")[0];
    }
  }
  return null;
}

// Log in and return the session data (API client mode returns the bearer token).
export async function login(baseUrl, email, password = DEMO_PASSWORD) {
  return api(baseUrl, "/login", {
    method: "POST",
    body: JSON.stringify({ email, password, client: "api" })
  });
}

export function bearer(session) {
  return { Authorization: `Bearer ${session.data.session.token}` };
}

// Poll until fn() returns a truthy value, or throw at the deadline.
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

// Poll /api/state until the payment reaches one of the given statuses.
export function waitForPaymentStatus(baseUrl, paymentId, statuses, headers, timeoutMs = 10000) {
  const wanted = [statuses].flat();
  return waitFor(async () => {
    const state = await api(baseUrl, "/state", { headers });
    const payment = state.data?.payments?.find((item) => item.id === paymentId);
    return payment && wanted.includes(payment.status) ? payment : null;
  }, { timeoutMs, label: `payment ${paymentId} status ${wanted.join("/")}` });
}

export function collectChildLogs(stack) {
  return (stack._children || [])
    .flatMap((child) => child.logs || [])
    .join("\n");
}
