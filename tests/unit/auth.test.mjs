import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, needsPasswordRehash, verifyCsrf, verifyPassword } from "../../packages/shared/auth.mjs";

test("hashPassword uses salted scrypt hashes and verifies them", () => {
  const first = hashPassword("demo123");
  const second = hashPassword("demo123");

  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.match(second, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second, "same password should not produce identical hashes");
  assert.equal(verifyPassword("demo123", first), true);
  assert.equal(verifyPassword("wrong", first), false);
  assert.equal(needsPasswordRehash(first), false);
});

test("legacy sha256 hashes verify only as a migration bridge and require rehash", () => {
  const legacy = createHash("sha256").update("demo123").digest("hex");

  assert.equal(verifyPassword("demo123", legacy), true);
  assert.equal(verifyPassword("wrong", legacy), false);
  assert.equal(needsPasswordRehash(legacy), true);
});

test("verifyCsrf requires a matching header token for cookie-authenticated users", () => {
  const user = { csrfToken: "token-abc" };

  assert.equal(verifyCsrf(user, "token-abc", { authSource: "cookie" }), true);
  assert.equal(verifyCsrf(user, "token-xyz", { authSource: "cookie" }), false);
  assert.equal(verifyCsrf(user, "", { authSource: "cookie" }), false);
  assert.equal(verifyCsrf(user, undefined, { authSource: "cookie" }), false);
});

test("verifyCsrf rejects cookie sessions without a CSRF token (legacy/null sessions)", () => {
  assert.equal(verifyCsrf({ csrfToken: null }, "anything", { authSource: "cookie" }), false);
  assert.equal(verifyCsrf({ csrfToken: "" }, "", { authSource: "cookie" }), false);
  assert.equal(verifyCsrf({}, "anything", { authSource: "cookie" }), false);
  assert.equal(verifyCsrf(null, "anything", { authSource: "cookie" }), false);
});

test("verifyCsrf skips validation for bearer-authenticated requests", () => {
  assert.equal(verifyCsrf({ csrfToken: null }, "", { authSource: "bearer" }), true);
  assert.equal(verifyCsrf({ csrfToken: "token-abc" }, "", { authSource: "bearer" }), true);
});
