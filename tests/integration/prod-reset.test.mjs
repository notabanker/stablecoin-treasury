import { test } from "node:test";
import assert from "node:assert/strict";
import { api, extractCookie, login } from "../helpers/api.mjs";
import { startStack } from "../helpers/stack.mjs";

// Production-mode reset HTTP test (audit finding M7 / gate A1.4).
// Verifies the /api/reset endpoint behavior under production-like configuration.

async function loginAdmin(baseUrl) {
  const loginRes = await login(baseUrl, "marta@vega-industries.com");
  assert.equal(loginRes.status, 200, "admin login required for production-mode reset tests");
  const session = extractCookie(loginRes.setCookie, "session");
  const csrf = extractCookie(loginRes.setCookie, "csrf");
  assert.ok(session && csrf, "login must return session and csrf cookies");
  return {
    Cookie: `session=${session}; csrf=${csrf}`,
    "X-Csrf-Token": csrf
  };
}

test("POST /api/reset with explicit PRODUCTION_MODE=true returns 403 when ALLOW_DEMO_RESET is unset", async (t) => {
  const stack = await startStack({ extraEnv: { PRODUCTION_MODE: "true", ALLOW_DEMO_RESET: "false" } });
  t.after(() => stack.stop());

  const headers = await loginAdmin(stack.baseUrl);
  const res = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers,
    body: "{}"
  });

  assert.equal(res.status, 403, "demo reset must be blocked in production mode by default");
  assert.equal(res.data.error, "demo_reset_disabled", "error code must be demo_reset_disabled");
});

test("POST /api/reset succeeds when ALLOW_DEMO_RESET is exactly 'true'", async (t) => {
  const stack = await startStack({ extraEnv: { PRODUCTION_MODE: "true", ALLOW_DEMO_RESET: "true" } });
  t.after(() => stack.stop());

  const headers = await loginAdmin(stack.baseUrl);
  const res = await api(stack.baseUrl, "/reset", {
    method: "POST",
    headers,
    body: "{}"
  });

  assert.equal(res.status, 200, "demo reset must succeed when ALLOW_DEMO_RESET=true");
  assert.ok(res.data.state, "response must contain state");
});

test("POST /api/reset succeeds in dev mode (no PRODUCTION_MODE)", async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());

  const res = await api(stack.baseUrl, "/reset", {
    method: "POST",
    body: "{}"
  });

  assert.equal(res.status, 200, "demo reset must succeed in dev mode");
  assert.ok(res.data.state, "response must contain state after reset");
});
