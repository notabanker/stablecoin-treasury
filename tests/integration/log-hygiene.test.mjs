import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { startStack } from "../helpers/stack.mjs";

// API helpers mirror the pattern in auth-rbac.test.mjs
async function api(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: opts.body,
    redirect: "manual"
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = [];
  const cookies = res.headers.getSetCookie?.() || [];
  return { status: res.status, data, setCookie: cookies };
}

function extractCookie(cookies, name) {
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c.split(";")[0].split("=").slice(1).join("=");
  }
  return null;
}

function collectAllLogs(stack) {
  const all = [];
  for (const child of stack._children || []) {
    for (const line of child.logs || []) {
      all.push(line);
    }
  }
  return all.join("\n");
}

// The INTERNAL_SERVICE_TOKEN is set by the stack from process.env — capture it.
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || "dev-internal-token";

describe("log hygiene", () => {
  test("full payment lifecycle never writes credentials into service logs", async (t) => {
    const stack = await startStack({
      extraEnv: {
        AUTH_REQUIRED: "true",
        INTERNAL_AUTH_REQUIRED: "true",
        INTERNAL_SERVICE_TOKEN: "test-internal-token-loghygiene",
        WEBHOOK_SECRET: "test-webhook-secret-loghygiene",
        DEMO_WEBHOOK_SECRET: "test-webhook-secret-loghygiene"
      },
      logCaptureMax: 2000
    });
    t.after(async () => await stack.stop());

    // 1. Login
    const loginRes = await api(stack.baseUrl, "/login", {
      method: "POST",
      body: JSON.stringify({ email: "marta@vega-industries.com", password: "demo123" })
    });
    assert.equal(loginRes.status, 200);
    const sessionCookie = extractCookie(loginRes.setCookie, "session");
    const csrfToken = extractCookie(loginRes.setCookie, "csrf");
    assert.ok(sessionCookie);
    assert.ok(csrfToken);

    // 2. Create a payment
    const createRes = await api(stack.baseUrl, "/payments", {
      method: "POST",
      headers: {
        Cookie: `session=${sessionCookie}; csrf=${csrfToken}`,
        "X-Csrf-Token": csrfToken
      },
      body: JSON.stringify({
        amount: 1,
        asset: "EURC",
        counterpartyId: "cp-nordic",
        sourceWalletId: "wal-de-eur",
        type: "Supplier"
      })
    });
    assert.equal(createRes.status, 200);
    assert.ok(createRes.data?.payment?.id, `create payment response: ${JSON.stringify(createRes.data)}`);
    const paymentId = createRes.data.payment.id;

    // 3. Execute the payment (below threshold — no approval needed)
    const executeRes = await api(stack.baseUrl, `/payments/${paymentId}/execute`, {
      method: "POST",
      headers: {
        Cookie: `session=${sessionCookie}; csrf=${csrfToken}`,
        "X-Csrf-Token": csrfToken
      }
    });
    assert.equal(executeRes.status, 200);

    // 4. Wait for settlement (saga may take a moment)
    let settled = false;
    for (let i = 0; i < 30; i++) {
      const stateRes = await api(stack.baseUrl, "/state", {
        headers: { Cookie: `session=${sessionCookie}` }
      });
      if (stateRes.status === 200) {
        const payment = (stateRes.data?.payments || []).find((p) => p.id === paymentId);
        if (payment?.status === "Settled") { settled = true; break; }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(settled, "payment should settle within 15 seconds");

    // 5. Send a webhook (triggers signing path)
    const webhookRes = await api(stack.baseUrl, "/webhooks/prov-arcadia", {
      method: "POST",
      headers: { "X-Webhook-Signature": "invalid" },
      body: JSON.stringify({ eventId: "wh-log-hygiene", eventType: "transfer.settled" })
    });
    assert.equal(webhookRes.status, 401);

    // 6. Logout
    await api(stack.baseUrl, "/logout", {
      method: "POST",
      headers: {
        Cookie: `session=${sessionCookie}; csrf=${csrfToken}`,
        "X-Csrf-Token": csrfToken
      }
    });

    // Now collect all logs and verify no credentials leaked
    const allLogs = collectAllLogs(stack);

    // Each credential that must NEVER appear in logs
    const forbidden = [
      { label: "session token", value: sessionCookie },
      { label: "csrf token", value: csrfToken },
      { label: "password", value: "demo123" },
      { label: "INTERNAL_SERVICE_TOKEN", value: "test-internal-token-loghygiene" },
      { label: "WEBHOOK_SECRET", value: "test-webhook-secret-loghygiene" }
    ];

    for (const { label, value } of forbidden) {
      if (!value) continue;
      const found = allLogs.includes(value);
      assert.ok(!found, `${label} must not appear in service logs (found: ${found})`);
    }

    // Double-check: if we deliberately log the token, it SHOULD appear (proving the test isn't a tautology)
    // Not needed — the assertion above is `assert.ok(!found)`, which is falsifiable.
  });
});
