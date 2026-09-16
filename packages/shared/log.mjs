// Structured logging: one JSON object per line, as the rest of the platform already emits.
// `at` and `event` are always first so log scanners can key on them.
export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

export function logError(event, error, fields = {}) {
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    event,
    message: error?.message ?? String(error),
    ...fields
  }));
}
