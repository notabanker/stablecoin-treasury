import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { api, collectChildLogs, extractCookie, login, waitForPaymentStatus } from "../helpers/api.mjs";
import { startStack } from "../helpers/stack.mjs";

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
    const loginRes = await login(stack.baseUrl, "marta@vega-industries.com");
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
        "X-Csrf-Token": csrfToken,
        "Idempotency-Key": "log-hygiene-create-1"
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
    const settled = await waitForPaymentStatus(
      stack.baseUrl,
      paymentId,
      "Settled",
      { Cookie: `session=${sessionCookie}` },
      15000
    );
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
    const allLogs = collectChildLogs(stack);

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
