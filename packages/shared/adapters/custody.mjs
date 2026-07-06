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
  async submitTransfer(request) {
    const providerRef = request.payment.providerRef || `ARC-${randomHex(5)}`;
    const chainRef = request.payment.chainRef || `0x${randomHex(14).toLowerCase()}`;
    return { providerRef, chainRef, status: "submitted" };
  }
  async getTransferStatus(providerRef) {
    return { status: "settled", providerRef };
  }
  async getBalances(walletRef) {
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

export async function resolveAdapter(providerId) {
  const { rows } = await query("operations",
    "SELECT adapter FROM operations.providers WHERE id = $1 LIMIT 1",
    [providerId]
  );
  if (!rows[0]) return null;
  const key = rows[0].adapter;
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
  return factory();
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
