// pg returns timestamptz columns as Date objects; the JSON API exposes ISO strings.
// `iso` passes strings and null through untouched, so it is safe on both driver shapes.

export function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function isoOrEmpty(value) {
  return value ? iso(value) : "";
}
