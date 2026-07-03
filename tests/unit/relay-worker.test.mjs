import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("relay claim path does not mark outbox events published before delivery", () => {
  const source = readFileSync("services/relay-worker/src/index.mjs", "utf8");
  const claimStart = source.indexOf("async function getUnpublishedEvents()");
  const markStart = source.indexOf("async function markPublished(");
  assert.ok(claimStart >= 0, "relay should expose getUnpublishedEvents");
  assert.ok(markStart > claimStart, "markPublished should follow the claim helper");

  const claimBody = source.slice(claimStart, markStart);
  assert.equal(
    /published_at\s*=\s*now\(\)/i.test(claimBody),
    false,
    "claiming must not set published_at; only successful delivery may publish"
  );
  assert.equal(source.includes("markPublishedInTx"), false);
});
