import { query } from "../db.mjs";
import { randomHex } from "../data.mjs";

// CustodyAdapter interface — implemented by SimulatedCustodyAdapter (built-in)
// and future per-provider implementations (sandbox rail, live custody provider, etc.).
// All methods are async and must not throw on transient failures (the saga retries).

export class CustodyAdapter {
  async getBalances(walletRef) { throw new Error("Not implemented"); }
  async submitTransfer(request) { throw new Error("Not implemented"); }
  async getTransferStatus(providerRef) { throw new Error("Not implemented"); }
}

// SimulatedCustodyAdapter — replicas current in-process simulation exactly so the
// full suite passes unchanged. This proves the adapter seam is pure refactor.
export class SimulatedCustodyAdapter extends CustodyAdapter {
  // Idempotency store: simulates what a real provider's API guarantees server-side -- the
  // same idempotencyKey always returns the same transfer result instead of creating a new
  // one, regardless of how many times the caller (crash-)retries submitTransfer with it.
  // (V8 Task 0.3, Finding 1.) Per-process, which matches this adapter's other in-memory
  // state (the circuit breaker registry); fine for the simulated rail and for tests, where
  // each test stack is a fresh process.
  #submissions = new Map();

  async submitTransfer(request) {
    const key = request.idempotencyKey;
    if (key && this.#submissions.has(key)) {
      return this.#submissions.get(key);
    }
    const providerRef = request.payment.providerRef || `ARC-${randomHex(5)}`;
    const chainRef = request.payment.chainRef || `0x${randomHex(14).toLowerCase()}`;
    const result = { providerRef, chainRef, status: "submitted" };
    if (key) this.#submissions.set(key, result);
    return result;
  }
  async getTransferStatus(providerRef) {
    return { status: "settled", providerRef };
  }
  async getBalances(walletRef) {
    return { balances: [] };
  }
}

// V8 Task 0.3.6 crash-injection test double: on its first call for a given idempotencyKey it
// records the transfer as "accepted by the provider" (mirroring what a real provider's server
// does) and then throws -- simulating an ambiguous outcome (process crash, or a network
// timeout where the request actually succeeded server-side). Any later call with the SAME
// idempotencyKey returns the already-accepted result instead of throwing again, exactly like a
// real idempotent provider API. Gated behind an explicit opt-in env var (mirrors the
// SIMULATED_STATEMENT_EMIT precedent in job-worker) so it can never be selected in a real
// deployment; a test can only reach it by seeding operations.providers.adapter to this key in
// its own throwaway database.
class CrashOnceThenIdempotentAdapter extends CustodyAdapter {
  #accepted = new Map();
  callCount = 0;

  async submitTransfer(request) {
    this.callCount += 1;
    const key = request.idempotencyKey;
    if (key && this.#accepted.has(key)) {
      return this.#accepted.get(key);
    }
    const result = { providerRef: `CRASH-${key}`, chainRef: `0xcrash-${key}`, status: "submitted" };
    if (key) this.#accepted.set(key, result);
    if (this.callCount === 1) {
      throw new Error("simulated crash: provider accepted the transfer but the process died before persisting the result");
    }
    return result;
  }

  async getTransferStatus() {
    return { status: "settled" };
  }

  async getBalances() {
    return { balances: [] };
  }
}

// Adapter registry — resolves the provider row to an adapter instance.
// Unknown adapter keys make the provider unusable (alert-worthy), never crash.
const registry = new Map();

export function registerAdapter(key, factory) {
  registry.set(key, factory);
}

// Default built-in adapter.
registerAdapter("simulated", () => new SimulatedCustodyAdapter());

if (process.env.CUSTODY_TEST_CRASH_ADAPTER === "true") {
  registerAdapter("crash-once-then-idempotent", () => new CrashOnceThenIdempotentAdapter());
}

// Adapter instances are memoized per adapter key, not re-created on every resolveAdapter()
// call. A fresh instance per call would silently discard any in-process idempotency state the
// adapter keeps between a crashed attempt and its retry (a completely separate saga run, hence
// a completely separate call to resolveAdapter) -- exactly the state Task 0.3's crash-safety
// depends on for the simulated rail. A real adapter would hold a persistent client/connection
// for the same reason.
const instances = new Map();

export async function resolveAdapter(providerId) {
  const { rows } = await query("operations",
    "SELECT adapter FROM operations.providers WHERE id = $1 LIMIT 1",
    [providerId]
  );
  if (!rows[0]) return null;
  const key = rows[0].adapter;
  if (instances.has(key)) return instances.get(key);
  const factory = registry.get(key);
  if (!factory) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "adapter_not_found",
      providerId,
      adapterKey: key
    }));
    return null;
  }
  const instance = factory();
  instances.set(key, instance);
  return instance;
}

// Circuit breaker: per-provider state machine. Tracks consecutive failures; opens
// after N consecutive failures, probes in half-open state, closes on success.
const breakers = new Map();

export function breakerState(providerId) {
  return breakers.get(providerId) || { state: "closed", failures: 0, openedAt: 0 };
}

export function breakerStateForMetrics(providerId) {
  const b = breakerState(providerId);
  return { state: b.state, failures: b.failures };
}

export async function withBreaker(providerId, fn) {
  const MAX_FAILURES = Number(process.env.BREAKER_MAX_FAILURES || 5);
  const RESET_MS = Number(process.env.BREAKER_RESET_MS || 30000);
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
