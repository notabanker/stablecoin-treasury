const PRODUCTION_MODE = process.env.PRODUCTION_MODE === "true";

// Demo reset gate (V8 Task 0.1.1, audit finding H1). POST /api/reset destroys and reseeds
// operational data (payments, wallets, the tenant audit trail). Outside production mode it is
// a normal demo/dev convenience (and npm run smoke relies on it). In PRODUCTION_MODE it is
// destructive and MUST stay off unless an operator explicitly opts in with
// ALLOW_DEMO_RESET=true (exact match — any other value keeps it disabled, fail-closed).
// Reads process.env at call time so tests and per-request checks see current values.
export function isDemoResetAllowed() {
  if (process.env.PRODUCTION_MODE !== "true") return true;
  return process.env.ALLOW_DEMO_RESET === "true";
}

const SENSITIVE_KEYS = new Set([
  "INTERNAL_SERVICE_TOKEN", "WEBHOOK_SECRET", "DEMO_WEBHOOK_SECRET",
  "DATABASE_URL", "SESSION_COOKIE_SECRET"
]);

function check(condition, message) {
  return condition ? null : message;
}

function redacted(val) {
  if (!val) return "<unset>";
  if (val.length <= 8) return "***";
  return val.slice(0, 4) + "***" + val.slice(-4);
}

export function validateProductionConfig(serviceName) {
  if (!PRODUCTION_MODE) return { ok: true };

  const failures = [];

  failures.push(check(process.env.AUTH_REQUIRED === "true",
    "AUTH_REQUIRED must be 'true'"));
  failures.push(check(process.env.INTERNAL_AUTH_REQUIRED === "true",
    "INTERNAL_AUTH_REQUIRED must be 'true'"));

  const token = process.env.INTERNAL_SERVICE_TOKEN;
  failures.push(check(token && token !== "dev-internal-token",
    `INTERNAL_SERVICE_TOKEN must be set (not the default). Current: ${redacted(token)}`));

  const cors = process.env.CORS_ORIGIN;
  failures.push(check(cors && cors !== "*" && cors !== "",
    `CORS_ORIGIN must be explicit and not "*". Current: ${cors || "<unset>"}`));

  const dbUrl = process.env.DATABASE_URL || "";
  failures.push(check(
    !dbUrl.includes("127.0.0.1") && !dbUrl.includes("localhost") && !dbUrl.includes("treasury_dev"),
    `DATABASE_URL must not point to localhost or treasury_dev. Current: ${redacted(dbUrl)}`
  ));

  failures.push(check(process.env.NODE_ENV === "production",
    `NODE_ENV must be 'production'. Current: ${process.env.NODE_ENV || "<unset>"}`));

  // Gateway/web-specific checks
  if (serviceName === "api-gateway" || serviceName === "gateway") {
    failures.push(check(process.env.SESSION_COOKIE_SECURE === "true",
      "SESSION_COOKIE_SECURE must be 'true'"));

    const demoSecret = process.env.DEMO_WEBHOOK_SECRET || "sandbox-webhook-secret";
    failures.push(check(
      process.env.DEMO_WEBHOOK_SECRET !== "sandbox-webhook-secret" || !process.env.DEMO_WEBHOOK_SECRET,
      `DEMO_WEBHOOK_SECRET must not be the default 'sandbox-webhook-secret'`
    ));

    const webhookSecret = process.env.WEBHOOK_SECRET;
    failures.push(check(
      webhookSecret && webhookSecret !== "sandbox-webhook-secret",
      `WEBHOOK_SECRET must be set (not default). Current: ${redacted(webhookSecret)}`
    ));

    // Demo credential gate: seed users must not use demo passwords in production.
    // SHA-256 of "demo123" is d3ad931... ; scrypt format starts with "scrypt$".
    // The scrypt demo hash is checked via DB query at startup (see 2.4 in auth.mjs).
    if (process.env.DEMO_SEED_ENABLED === "true") {
      failures.push("DEMO_SEED_ENABLED must not be 'true' in production mode");
    }
  }

  const errors = failures.filter(Boolean);
  if (errors.length > 0) {
    const msg = `[${serviceName}] Production config validation failed:\n  - ${errors.join("\n  - ")}`;
    throw new Error(msg);
  }

  return { ok: true };
}
