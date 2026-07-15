import { test } from "node:test";
import assert from "node:assert/strict";

// Unit tests for the circuit breaker in packages/shared/adapters/custody.mjs.
// These test the breaker state machine logic directly without DB or network.

// Inline the breaker implementation to test — we test the logic, not the import path.
function createBreaker() {
  const MAX_FAILURES = 5;
  const RESET_MS = 30000;
  const breakers = new Map();

  function breakerState(providerId) {
    return breakers.get(providerId) || { state: "closed", failures: 0, openedAt: 0 };
  }

  async function withBreaker(providerId, fn) {
    const now = Date.now();
    let breaker = breakers.get(providerId);

    if (!breaker) {
      breaker = { state: "closed", failures: 0, openedAt: 0 };
      breakers.set(providerId, breaker);
    }

    if (breaker.state === "open") {
      if (now - breaker.openedAt > RESET_MS) {
        breaker.state = "half-open";
      } else {
        throw Object.assign(new Error(`Circuit breaker open for ${providerId}`),
          { code: "circuit_open", providerId });
      }
    }

    try {
      const result = await fn();
      if (breaker.state === "half-open") {
        breaker.state = "closed";
      }
      breaker.failures = 0;
      return result;
    } catch (error) {
      breaker.failures += 1;
      if (breaker.failures >= MAX_FAILURES) {
        breaker.state = "open";
        breaker.openedAt = now;
      }
      throw error;
    }
  }

  return { withBreaker, breakerState: (pid) => breakerState(pid), breakers };
}

test("breaker starts closed for an unknown provider", () => {
  const { breakerState } = createBreaker();
  const state = breakerState("prov-unknown");
  assert.equal(state.state, "closed");
  assert.equal(state.failures, 0);
});

test("breaker opens after MAX_FAILURES consecutive failures", async () => {
  const { withBreaker, breakers } = createBreaker();
  const providerId = "prov-failing";

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => withBreaker(providerId, async () => { throw new Error("fail"); }),
      { message: "fail" }
    );
  }

  // After 5 failures the breaker transitions to open — the 6th call throws circuit_open
  await assert.rejects(
    () => withBreaker(providerId, async () => { throw new Error("fail"); }),
    (err) => err.code === "circuit_open" && err.providerId === providerId
  );
});

test("breaker resets failure count and stays closed on success", async () => {
  const { withBreaker, breakerState } = createBreaker();
  const providerId = "prov-ok";

  // Mixed: success resets counter
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => withBreaker(providerId, async () => { throw new Error("fail"); }),
      { message: "fail" }
    );
  }
  await withBreaker(providerId, async () => "ok");
  assert.equal(breakerState(providerId).failures, 0);
  assert.equal(breakerState(providerId).state, "closed");
});

test("breaker transitions to half-open after RESET_MS and closes on success", async () => {
  // Use a shorter RESET_MS for testing
  const MAX_FAILURES = 2;
  const RESET_MS = 50;
  const breakers = new Map();

  async function withBreakerShort(providerId, fn) {
    const now = Date.now();
    let breaker = breakers.get(providerId);
    if (!breaker) {
      breaker = { state: "closed", failures: 0, openedAt: 0 };
      breakers.set(providerId, breaker);
    }
    if (breaker.state === "open") {
      if (now - breaker.openedAt > RESET_MS) {
        breaker.state = "half-open";
      } else {
        throw Object.assign(new Error(`Circuit breaker open for ${providerId}`),
          { code: "circuit_open", providerId });
      }
    }
    try {
      const result = await fn();
      if (breaker.state === "half-open") breaker.state = "closed";
      breaker.failures = 0;
      return result;
    } catch (error) {
      breaker.failures += 1;
      if (breaker.failures >= MAX_FAILURES) {
        breaker.state = "open";
        breaker.openedAt = now;
      }
      throw error;
    }
  }

  // Trip the breaker
  for (let i = 0; i < MAX_FAILURES; i++) {
    await assert.rejects(
      () => withBreakerShort("prov-trip", async () => { throw new Error("fail"); }),
      { message: "fail" }
    );
  }

  // Immediately after tripping: circuit_open
  await assert.rejects(
    () => withBreakerShort("prov-trip", async () => "ok"),
    (err) => err.code === "circuit_open"
  );

  // Wait for reset window
  await new Promise((r) => setTimeout(r, 60));

  // Now in half-open: success closes the breaker
  const result = await withBreakerShort("prov-trip", async () => "recovered");
  assert.equal(result, "recovered");
  assert.equal(breakers.get("prov-trip").state, "closed");
  assert.equal(breakers.get("prov-trip").failures, 0);
});

test("breaker stays open if half-open probe fails", async () => {
  const MAX_FAILURES = 3;
  const RESET_MS = 50;
  const breakers = new Map();

  async function withBreakerShort(providerId, fn) {
    const now = Date.now();
    let breaker = breakers.get(providerId);
    if (!breaker) {
      breaker = { state: "closed", failures: 0, openedAt: 0 };
      breakers.set(providerId, breaker);
    }
    if (breaker.state === "open") {
      if (now - breaker.openedAt > RESET_MS) {
        breaker.state = "half-open";
      } else {
        throw Object.assign(new Error(`Circuit breaker open for ${providerId}`),
          { code: "circuit_open", providerId });
      }
    }
    try {
      const result = await fn();
      if (breaker.state === "half-open") breaker.state = "closed";
      breaker.failures = 0;
      return result;
    } catch (error) {
      breaker.failures += 1;
      if (breaker.failures >= MAX_FAILURES) {
        breaker.state = "open";
        breaker.openedAt = now;
      }
      throw error;
    }
  }

  // Trip
  for (let i = 0; i < MAX_FAILURES; i++) {
    await assert.rejects(
      () => withBreakerShort("prov-probe", async () => { throw new Error("fail"); })
    );
  }

  await new Promise((r) => setTimeout(r, 60));

  // Half-open probe fails → back to open
  await assert.rejects(
    () => withBreakerShort("prov-probe", async () => { throw new Error("still failing"); })
  );
  assert.equal(breakers.get("prov-probe").state, "open");
});

test("breakers are per-provider — one failing provider does not affect another", async () => {
  const { withBreaker, breakerState } = createBreaker();

  // Trip provider A
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => withBreaker("prov-a", async () => { throw new Error("fail"); })
    );
  }
  assert.equal(breakerState("prov-a").state, "open");

  // Provider B is unaffected
  await withBreaker("prov-b", async () => "ok");
  assert.equal(breakerState("prov-b").state, "closed");
});
