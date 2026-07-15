import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const originalEnv = { ...process.env };
let importNonce = 0;

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
  delete process.env.PRODUCTION_MODE;
}

afterEach(resetEnv);

async function validateProd() {
  // Re-import to get fresh module state after env changes
  const mod = await import(`../../packages/shared/config.mjs?test=${++importNonce}`);
  return mod.validateProductionConfig;
}

async function demoResetAllowed() {
  // isDemoResetAllowed reads process.env at call time, so a fresh import is not
  // required — but importing here keeps it consistent with validateProd().
  const mod = await import(`../../packages/shared/config.mjs?test=${++importNonce}`);
  return mod.isDemoResetAllowed;
}

test("demo reset is allowed outside production mode (dev/smoke unaffected)", async () => {
  delete process.env.PRODUCTION_MODE;
  delete process.env.ALLOW_DEMO_RESET;
  const isDemoResetAllowed = await demoResetAllowed();
  assert.equal(isDemoResetAllowed(), true);
});

test("demo reset is blocked in production mode when ALLOW_DEMO_RESET is unset (H1)", async () => {
  process.env.PRODUCTION_MODE = "true";
  delete process.env.ALLOW_DEMO_RESET;
  const isDemoResetAllowed = await demoResetAllowed();
  assert.equal(isDemoResetAllowed(), false);
});

test("demo reset is blocked in production mode when ALLOW_DEMO_RESET is not exactly 'true'", async () => {
  process.env.PRODUCTION_MODE = "true";
  const isDemoResetAllowed = await demoResetAllowed();
  for (const value of ["false", "1", "yes", "TRUE", ""]) {
    process.env.ALLOW_DEMO_RESET = value;
    assert.equal(isDemoResetAllowed(), false, `ALLOW_DEMO_RESET=${JSON.stringify(value)} must not enable reset`);
  }
});

test("demo reset is allowed in production mode only when ALLOW_DEMO_RESET is exactly 'true'", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.ALLOW_DEMO_RESET = "true";
  const isDemoResetAllowed = await demoResetAllowed();
  assert.equal(isDemoResetAllowed(), true);
});

test("non-production mode passes with local defaults", async () => {
  delete process.env.PRODUCTION_MODE;
  const validate = await validateProd();
  const result = validate("api-gateway");
  assert.equal(result.ok, true);
});

test("production mode fails if AUTH_REQUIRED is not true", async () => {
  process.env.PRODUCTION_MODE = "true";
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /AUTH_REQUIRED/);
});

test("production mode fails if INTERNAL_SERVICE_TOKEN is missing or default", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /INTERNAL_SERVICE_TOKEN/);
});

test("production mode fails if DATABASE_URL points to localhost", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  process.env.INTERNAL_SERVICE_TOKEN = "prod-secret-token-abc123";
  process.env.CORS_ORIGIN = "https://treasury.example.com";
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/treasury_dev";
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /DATABASE_URL/);
});

test("production mode fails if CORS_ORIGIN is missing or wildcard", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  process.env.INTERNAL_SERVICE_TOKEN = "prod-secret-token-abc123";
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /CORS_ORIGIN/);
});

test("production mode passes with a safe production config", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  process.env.INTERNAL_SERVICE_TOKEN = "prod-internal-token-a1b2c3d4e5f6";
  process.env.CORS_ORIGIN = "https://treasury.example.com";
  process.env.DATABASE_URL = "postgres://db.internal:5432/treasury_prod";
  process.env.NODE_ENV = "production";
  process.env.SESSION_COOKIE_SECURE = "true";
  process.env.DEMO_WEBHOOK_SECRET = "prod-webhook-secret";
  process.env.WEBHOOK_SECRET = "prod-webhook-secret-xyz";
  process.env.SERVICE_DB_PASSWORD = "prod-svc-db-password-a1b2c3";
  const validate = await validateProd();
  const result = validate("api-gateway");
  assert.equal(result.ok, true);
});

test("production mode fails if SERVICE_DB_PASSWORD is missing or default (H4)", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  process.env.INTERNAL_SERVICE_TOKEN = "prod-token";
  process.env.CORS_ORIGIN = "https://t.example.com";
  process.env.DATABASE_URL = "postgres://db.internal:5432/treasury_prod";
  process.env.NODE_ENV = "production";
  process.env.SESSION_COOKIE_SECURE = "true";
  process.env.DEMO_WEBHOOK_SECRET = "prod-secret";
  process.env.WEBHOOK_SECRET = "prod-secret";
  delete process.env.SERVICE_DB_PASSWORD;
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /SERVICE_DB_PASSWORD/);
  // Also fails with default value
  process.env.SERVICE_DB_PASSWORD = "service-dev-password";
  assert.throws(() => validate("api-gateway"), /SERVICE_DB_PASSWORD/);
});

test("error messages never include raw secret values", async () => {
  process.env.PRODUCTION_MODE = "true";
  const validate = await validateProd();
  try {
    validate("api-gateway");
  } catch (error) {
    assert.ok(!error.message.includes("dev-internal-token"), "should not leak default token in error message");
    // The redacted value shows "dev-***oken"
    assert.ok(!error.message.includes("dev-internal"), "should not leak raw token");
  }
});

test("gateway validates webhook and session-specific settings", async () => {
  process.env.PRODUCTION_MODE = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.INTERNAL_AUTH_REQUIRED = "true";
  process.env.INTERNAL_SERVICE_TOKEN = "prod-token";
  process.env.CORS_ORIGIN = "https://t.example.com";
  process.env.DATABASE_URL = "postgres://db.internal:5432/treasury_prod";
  process.env.NODE_ENV = "production";
  // Missing SESSION_COOKIE_SECURE
  const validate = await validateProd();
  assert.throws(() => validate("api-gateway"), /SESSION_COOKIE_SECURE/);
});
