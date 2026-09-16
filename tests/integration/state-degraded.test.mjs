import { test } from "node:test";
import assert from "node:assert/strict";
import { api, waitFor } from "../helpers/api.mjs";
import { startStackFor } from "../helpers/stack.mjs";

// GET /api/state is degraded-tolerant: one unreachable domain service must not fail the whole
// read. The contract that makes that safe is the `degraded` array -- without it an outage looks
// exactly like an empty desk, because the affected slices come back as empty collections. These
// tests pin both halves: the read still succeeds, AND it says which services are missing.

test("GET /api/state reports an unreachable service in degraded instead of failing", async (t) => {
  const stack = await startStackFor(t);

  const healthy = await api(stack.baseUrl, "/state");
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.data.degraded, [], "a healthy stack reports nothing degraded");
  assert.ok(healthy.data.payments.length > 0, "seeded payments are visible while healthy");
  assert.ok(healthy.data.wallets.length > 0, "seeded wallets are visible while healthy");

  const payment = stack._children.find((child) => child.name === "payment");
  assert.ok(payment, "stack exposes the payment service child process");
  payment.child.kill("SIGTERM");

  const degraded = await waitFor(async () => {
    const response = await api(stack.baseUrl, "/state");
    return response.data?.degraded?.length ? response : null;
  }, { timeoutMs: 15000, label: "payment-service outage to surface in /api/state" });

  assert.equal(degraded.status, 200, "one service down must not fail the whole state read");
  assert.ok(
    degraded.data.degraded.includes("payment"),
    `expected payment in degraded, got ${JSON.stringify(degraded.data.degraded)}`
  );
  assert.deepEqual(degraded.data.payments, [], "the payment slice degrades to an empty collection");
  assert.ok(degraded.data.wallets.length > 0, "healthy slices still return their real data");
});

test("the degraded banner distinguishes an outage from an empty desk", async (t) => {
  const stack = await startStackFor(t);

  const payment = stack._children.find((child) => child.name === "payment");
  payment.child.kill("SIGTERM");

  const response = await waitFor(async () => {
    const attempt = await api(stack.baseUrl, "/state");
    return attempt.data?.degraded?.length ? attempt : null;
  }, { timeoutMs: 15000, label: "payment-service outage to surface in /api/state" });

  // Render the real shell banner against the real payload: an empty payments table plus a
  // silent page is the failure this test exists to prevent.
  globalThis.document = { querySelector: () => ({ innerHTML: "", addEventListener: () => {} }) };
  const { state } = await import("../../apps/web/js/state.js");
  const { renderDegradedBanner } = await import("../../apps/web/js/views-shell.js");

  state.data = response.data;
  const banner = renderDegradedBanner();
  assert.match(banner, /role="alert"/, "the banner is announced to assistive tech");
  assert.match(banner, /payment/, "the banner names the unreachable service");
  assert.match(banner, /missing, not zero/, "the banner says the empty slices are missing data");
  assert.equal(
    (banner.match(/payment/g) || []).length,
    1,
    "a service owning several slices is listed once, not once per slice"
  );

  state.data = { degraded: [] };
  assert.equal(renderDegradedBanner(), "", "a healthy payload renders no banner");
});
