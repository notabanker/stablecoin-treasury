import { test } from "node:test";
import assert from "node:assert/strict";
import { startStack } from "../helpers/stack.mjs";

// Production-mode reset HTTP test (audit finding M7 / gate A1.4).
// Verifies the /api/reset endpoint behavior under production-like configuration.

function extractCookie(cookies, name) {
  const prefixes = [`${name}=`, `__Host-${name}=`];
  for (const c of cookies) {
    for (const prefix of prefixes) {
      if (c.startsWith(prefix)) return c.slice(prefix.length).split(";")[0];
    }
  }
  return null;
}

async function loginAdmin(baseUrl) {
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
  });
  assert.equal(loginRes.status, 200, "admin login required for production-mode reset tests");
  const session = extractCookie(loginRes.headers.getSetCookie?.() || [], "session");
  const csrf = extractCookie(loginRes.headers.getSetCookie?.() || [], "csrf");
  assert.ok(session && csrf, "login must return session and csrf cookies");
  return {
    Cookie: `session=${session}; csrf=${csrf}`,
    "X-Csrf-Token": csrf,
    "Content-Type": "application/json"
  };
}

test("POST /api/reset with explicit PRODUCTION_MODE=true returns 403 when ALLOW_DEMO_RESET is unset", async (t) => {
  const stack = await startStack({ extraEnv: { PRODUCTION_MODE: "true", ALLOW_DEMO_RESET: "false" } });
  t.after(() => stack.stop());

  const headers = await loginAdmin(stack.baseUrl);
  const res = await fetch(`${stack.baseUrl}/api/reset`, {
    method: "POST",
    headers,
    body: "{}"
  });

  assert.equal(res.status, 403, "demo reset must be blocked in production mode by default");
  const data = await res.json();
  assert.equal(data.error, "demo_reset_disabled", "error code must be demo_reset_disabled");
});

test("POST /api/reset succeeds when ALLOW_DEMO_RESET is exactly 'true'", async (t) => {
  const stack = await startStack({ extraEnv: { PRODUCTION_MODE: "true", ALLOW_DEMO_RESET: "true" } });
  t.after(() => stack.stop());

  const headers = await loginAdmin(stack.baseUrl);
  const res = await fetch(`${stack.baseUrl}/api/reset`, {
    method: "POST",
    headers,
    body: "{}"
  });

  assert.equal(res.status, 200, "demo reset must succeed when ALLOW_DEMO_RESET=true");
  const data = await res.json();
  assert.ok(data.state, "response must contain state");
});

test("POST /api/reset succeeds in dev mode (no PRODUCTION_MODE)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const res = await fetch(`${stack.baseUrl}/api/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });

  assert.equal(res.status, 200, "demo reset must succeed in dev mode");
  const data = await res.json();
  assert.ok(data.state, "response must contain state after reset");
});