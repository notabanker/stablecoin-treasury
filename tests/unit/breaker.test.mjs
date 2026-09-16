import { test } from "node:test";
import assert from "node:assert/strict";
import { withBreaker, breakerState } from "../../packages/shared/adapters/custody.mjs";

// Unit tests for the REAL circuit breaker in packages/shared/adapters/custody.mjs.
// withBreaker reads BREAKER_MAX_FAILURES / BREAKER_RESET_MS from process.env at call time and
// memoizes state per providerId, so each test sets its own env and uses a unique providerId to
// keep its breaker state isolated from every other test.

function failing(message = "fail") {
  return async () => { throw new Error(message); };
}

test("breaker starts closed for an unknown provider", () => {
  const state = breakerState("unit-breaker-unknown");
  assert.equal(state.state, "closed");
  assert.equal(state.failures, 0);
});

test("breaker opens after MAX_FAILURES consecutive failures", async () => {
  process.env.BREAKER_MAX_FAILURES = "5";
  process.env.BREAKER_RESET_MS = "30000";
  const providerId = "unit-breaker-opens";

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => withBreaker(providerId, failing()), { message: "fail" });
  }

  // After 5 failures the breaker transitions to open — the 6th call throws circuit_open
  await assert.rejects(
    () => withBreaker(providerId, failing()),
    (err) => err.code === "circuit_open" && err.providerId === providerId
  );
});

test("breaker resets failure count and stays closed on success", async () => {
  process.env.BREAKER_MAX_FAILURES = "5";
  process.env.BREAKER_RESET_MS = "30000";
  const providerId = "unit-breaker-resets";

  // Mixed: success resets counter
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => withBreaker(providerId, failing()), { message: "fail" });
  }
  await withBreaker(providerId, async () => "ok");
  assert.equal(breakerState(providerId).failures, 0);
  assert.equal(breakerState(providerId).state, "closed");
});

test("breaker transitions to half-open after RESET_MS and closes on success", async () => {
  process.env.BREAKER_MAX_FAILURES = "2";
  process.env.BREAKER_RESET_MS = "50";
  const providerId = "unit-breaker-half-open";

  // Trip the breaker
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => withBreaker(providerId, failing()), { message: "fail" });
  }

  // Immediately after tripping: circuit_open
  await assert.rejects(
    () => withBreaker(providerId, async () => "ok"),
    (err) => err.code === "circuit_open"
  );

  // Wait for reset window
  await new Promise((r) => setTimeout(r, 60));

  // Now in half-open: success closes the breaker
  const result = await withBreaker(providerId, async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(breakerState(providerId).state, "closed");
  assert.equal(breakerState(providerId).failures, 0);
});

test("breaker stays open if half-open probe fails", async () => {
  process.env.BREAKER_MAX_FAILURES = "3";
  process.env.BREAKER_RESET_MS = "50";
  const providerId = "unit-breaker-probe";

  // Trip
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => withBreaker(providerId, failing()));
  }

  await new Promise((r) => setTimeout(r, 60));

  // Half-open probe fails → back to open
  await assert.rejects(() => withBreaker(providerId, failing("still failing")));
  assert.equal(breakerState(providerId).state, "open");
});

test("breakers are per-provider — one failing provider does not affect another", async () => {
  process.env.BREAKER_MAX_FAILURES = "5";
  process.env.BREAKER_RESET_MS = "30000";

  // Trip provider A
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => withBreaker("unit-breaker-a", failing()));
  }
  assert.equal(breakerState("unit-breaker-a").state, "open");

  // Provider B is unaffected
  await withBreaker("unit-breaker-b", async () => "ok");
  assert.equal(breakerState("unit-breaker-b").state, "closed");
});
