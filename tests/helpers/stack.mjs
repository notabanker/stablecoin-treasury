import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
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
  ["gateway", "services/api-gateway/src/index.mjs", "GATEWAY_PORT"]
];

let nextPortBase = 5100;

function allocatePortBase() {
  const base = nextPortBase;
  nextPortBase += 20;
  return base;
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

export async function startStack({ verbose = false } = {}) {
  const portBase = allocatePortBase();
  const ports = {
    wallet: portBase + 1,
    policy: portBase + 2,
    compliance: portBase + 3,
    accounting: portBase + 5,
    reconciliation: portBase + 6,
    operations: portBase + 7,
    payment: portBase + 4,
    gateway: portBase
  };
  const database = await createTestDatabase();

  const sharedEnv = {
    ...process.env,
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
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...sharedEnv, [portEnvKey]: String(ports[name]) },
      stdio: ["ignore", verbose ? "inherit" : "pipe", verbose ? "inherit" : "pipe"]
    });
    if (!verbose) {
      child.stdout?.resume();
      child.stderr?.resume();
    }
    return { name, child };
  });

  try {
    await waitForAll(ports);
  } catch (error) {
    stopChildren(children);
    await dropDatabase(database.name);
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${ports.gateway}`,
    ports,
    databaseName: database.name,
    async stop() {
      stopChildren(children);
      await sleep(150);
      await dropDatabase(database.name);
    }
  };
}

function stopChildren(children) {
  for (const { child } of children) {
    child.kill("SIGTERM");
  }
}

async function waitForAll(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const names = Object.keys(ports);
  const ready = new Set();
  while (Date.now() < deadline) {
    for (const name of names) {
      if (ready.has(name)) continue;
      try {
        const response = await fetch(`http://127.0.0.1:${ports[name]}/health`);
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
