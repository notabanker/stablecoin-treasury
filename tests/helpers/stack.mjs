import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../../db/scripts/migrate.mjs";
import { SERVICES } from "../../packages/shared/services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";

// Each test file gets a fresh module (and thus a fresh nextPortBase), but a single process runs
// all test files so the module is shared. Use a hash of PID + time to stagger port ranges and
// avoid collisions when parallel test files start stacks simultaneously.
const portHash = (process.pid * 37 + Math.floor(Date.now() / 60000) * 31) % 5000;
let nextPortBase = 20000 + portHash;

async function allocatePortBase() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const base = nextPortBase;
    nextPortBase += 20;
    const candidates = Array.from({ length: 10 }, (_, offset) => base + offset);
    const availability = await Promise.all(candidates.map((port) => isPortAvailable(port)));
    if (availability.every(Boolean)) return base;
  }
  throw new Error("Unable to allocate a free 10-port block for the test stack");
}

// Each stack gets its own freshly migrated database, exactly like the temp-directory-per-stack
// approach this replaced for the JSON store. Postgres is a shared server (not a per-test
// process), so isolation has to come from the database name instead of a filesystem path.
async function createTestDatabase() {
  const name = `treasury_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), { quiet: true });
  return { name, url: url.toString() };
}

async function dropDatabase(name) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}

// Start a stack for a test with the ambient AUTH_REQUIRED forced when requested, and always
// restore it (and stop the stack) when the test ends. Leaving authRequired undefined keeps the
// current ambient value, for tests that rely on the environment they were started with.
export async function startStackFor(t, { authRequired, extraEnv = {}, verbose = false } = {}) {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  if (authRequired === true) process.env.AUTH_REQUIRED = "true";
  else if (authRequired === false) delete process.env.AUTH_REQUIRED;
  const stack = await startStack({ verbose, extraEnv });
  t.after(async () => {
    if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = previousAuthRequired;
    await stack.stop();
  });
  return stack;
}

export async function startStack({ verbose = false, extraEnv = {}, logCaptureMax = 80 } = {}) {
  const portBase = await allocatePortBase();
  // Port offsets follow the canonical service order (gateway at the base port).
  const ports = Object.fromEntries(SERVICES.map(({ name }, index) => [name, portBase + index]));
  const database = await createTestDatabase();

  const serviceDbPassword = process.env.SERVICE_DB_PASSWORD || "service-dev-password";

  // Build the admin URL parts.
  const adminUrlObj = new URL(database.url);
  const dbHost = adminUrlObj.hostname;
  const dbPort = adminUrlObj.port || "5432";

  function roleDbUrl(role) {
    return `postgres://${role}:${serviceDbPassword}@${dbHost}:${dbPort}${adminUrlObj.pathname}`;
  }

  const productionHarnessEnv = extraEnv.PRODUCTION_MODE === "true"
    ? {
        TEST_HARNESS_PRODUCTION_MODE: "true",
        NODE_ENV: "production",
        AUTH_REQUIRED: "true",
        INTERNAL_AUTH_REQUIRED: "true",
        INTERNAL_SERVICE_TOKEN: extraEnv.INTERNAL_SERVICE_TOKEN || "test-prod-internal-token-abc123",
        CORS_ORIGIN: extraEnv.CORS_ORIGIN || "http://127.0.0.1:8080",
        SESSION_COOKIE_SECURE: "true",
        SESSION_COOKIE_SECRET: extraEnv.SESSION_COOKIE_SECRET || "test-prod-session-secret-32chars-minimum",
        WEBHOOK_SECRET: extraEnv.WEBHOOK_SECRET || "test-prod-webhook-secret",
        DEMO_WEBHOOK_SECRET: extraEnv.DEMO_WEBHOOK_SECRET || "test-prod-demo-webhook-secret",
        SERVICE_DB_PASSWORD: extraEnv.SERVICE_DB_PASSWORD || "test-prod-svc-db-password"
      }
    : {};

  const sharedEnv = {
    ...process.env,
    ...productionHarnessEnv,
    ...extraEnv,
    DATABASE_URL: database.url,
    HOST: "127.0.0.1",
    WALLET_SERVICE_URL: `http://127.0.0.1:${ports.wallet}`,
    POLICY_SERVICE_URL: `http://127.0.0.1:${ports.policy}`,
    COMPLIANCE_SERVICE_URL: `http://127.0.0.1:${ports.compliance}`,
    PAYMENT_SERVICE_URL: `http://127.0.0.1:${ports.payment}`,
    ACCOUNTING_SERVICE_URL: `http://127.0.0.1:${ports.accounting}`,
    RECONCILIATION_SERVICE_URL: `http://127.0.0.1:${ports.reconciliation}`,
    OPERATIONS_SERVICE_URL: `http://127.0.0.1:${ports.operations}`,
    SERVICE_TIMEOUT_MS: "2500",
    SERVICE_RETRIES: "1"
  };

  const children = SERVICES.map(({ name, path, env, role }) => {
    const logs = [];
    const child = spawn(process.execPath, [path], {
      cwd: root,
      env: { ...sharedEnv, [env]: String(ports[name]), DATABASE_URL: roleDbUrl(role) },
      stdio: ["ignore", verbose ? "inherit" : "pipe", verbose ? "inherit" : "pipe"]
    });
    if (!verbose) {
      const capture = (stream, chunk) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) logs.push(`[${stream}] ${line}`);
        if (logs.length > logCaptureMax) logs.splice(0, logs.length - logCaptureMax);
      };
      child.stdout?.on("data", (chunk) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    }
    return { name, child, logs };
  });

  try {
    await waitForAll(ports, { timeoutMs: Number(process.env.TEST_STACK_READY_TIMEOUT_MS || 45000) });
  } catch (error) {
    error.message = `${error.message}\n${formatChildDiagnostics(children)}`;
    await stopChildren(children);
    await dropDatabase(database.name);
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${ports.gateway}`,
    ports,
    databaseName: database.name,
    // Exposed for failure-injection tests
    _children: children,
    _env: sharedEnv,
    _root: root,
    async stop() {
      await stopChildren(children);
      await dropDatabase(database.name);
    }
  };
}

async function stopChildren(children) {
  const promises = children.map(({ child }) => {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  });
  await Promise.allSettled(promises);
}

function formatChildDiagnostics(children) {
  return children.map(({ name, child, logs }) => {
    const exit = child.exitCode === null ? "running" : `exit=${child.exitCode}`;
    const signal = child.signalCode ? ` signal=${child.signalCode}` : "";
    const recent = logs.length ? logs.slice(-20).join("\n") : "(no captured output)";
    return `--- ${name} (${exit}${signal}) ---\n${recent}`;
  }).join("\n");
}

async function waitForAll(ports, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const names = Object.keys(ports);
  const ready = new Set();
  while (Date.now() < deadline) {
    for (const name of names) {
      if (ready.has(name)) continue;
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${ports[name]}/health`, 1000);
        if (response.ok) ready.add(name);
      } catch {
        // not up yet
      }
    }
    if (ready.size === names.length) return;
    await sleep(100);
  }
  const missing = names.filter((name) => !ready.has(name));
  throw new Error(`Stack failed to become ready, missing: ${missing.join(", ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
