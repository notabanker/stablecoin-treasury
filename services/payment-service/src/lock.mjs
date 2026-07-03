// Serializes async operations per key. Without this, two concurrent requests against the same
// payment id can both read a status like "Pending approval" before either one's await chain
// (policy evaluation, wallet/compliance lookups) resolves and writes the new state back --
// letting a two-approval payment collect far more than two approvals. This is an in-process
// substitute for the row-level lock a real database transaction would provide (see the M1/M2
// backlog); it only serializes calls within a single Node process, which matches this
// single-instance-per-service prototype.
const tails = new Map();

export function withLock(key, fn) {
  const previousTail = tails.get(key) || Promise.resolve();
  const result = previousTail.then(fn, fn);
  const nextTail = result.then(
    () => {},
    () => {}
  );
  tails.set(key, nextTail);
  nextTail.then(() => {
    // No cleanup if a newer call has already replaced this tail.
    if (tails.get(key) === nextTail) {
      tails.delete(key);
    }
  });
  return result;
}
