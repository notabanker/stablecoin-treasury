// Cache an expensive metrics snapshot (a DB query) for a short TTL and keep serving the last
// good value if a refresh fails: a broken metrics query must never break the scrape itself.
export function createMetricsSnapshot(refresh, { ttlMs = 5000, onError } = {}) {
  let cached = { at: 0, data: {} };
  return async function snapshot() {
    if (Date.now() - cached.at < ttlMs) return cached.data;
    try {
      cached = { at: Date.now(), data: await refresh() };
    } catch (error) {
      onError?.(error);
    }
    return cached.data;
  };
}
