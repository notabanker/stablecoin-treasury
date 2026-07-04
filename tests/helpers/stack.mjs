import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../../db/scripts/migrate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";

const serviceDefs = [
  ["wallet", "services/wallet-service/src/index.mjs", "PORT"],
  ["policy", "services/policy-service/src/index.mjs", "PORT"],
  ["compliance", "services/compliance-service/src/index.mjs", "PORT"],
  ["accounting", "services/accounting-service/src/index.mjs", "PORT"],
  ["reconciliation", "services/reconciliation-service/src/index.mjs", "PORT"],
  ["operations", "services/operations-service/src/index.mjs", "PORT"],
  ["payment", "services/payment-service/src/index.mjs", "PORT"],
  ["gateway", "services/api-gateway/src/index.mjs", "GATEWAY_PORT"],
  ["relay", "services/relay-worker/src/index.mjs", "PORT"],
  ["job", "services/job-worker/src/index.mjs", "PORT"]
];

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

export async function startStack({ verbose = false, extraEnv = {} } = {}) {
  const portBase = await allocatePortBase();
  const ports = {
    wallet: portBase + 1,
    policy: portBase + 2,
    compliance: portBase + 3,
    accounting: portBase + 5,
    reconciliation: portBase + 6,
    operations: portBase + 7,
    payment: portBase + 4,
    gateway: portBase,
    relay: portBase + 8,
    job: portBase + 9
  };
  const database = await createTestDatabase();

  const sharedEnv = {
    ...process.env,
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

  const children = serviceDefs.map(([name, script, portEnvKey]) => {
    const logs = [];
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...sharedEnv, [portEnvKey]: String(ports[name]) },
      stdio: ["ignore", verbose ? "inherit" : "pipe", verbose ? "inherit" : "pipe"]
    });
    if (!verbose) {
      const capture = (stream, chunk) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) logs.push(`[${stream}] ${line}`);
        if (logs.length > 80) logs.splice(0, logs.length - 80);
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
    _serviceDefs: serviceDefs,
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
