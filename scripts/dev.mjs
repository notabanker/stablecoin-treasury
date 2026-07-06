import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let shuttingDown = false;

const serviceDbPassword = process.env.SERVICE_DB_PASSWORD || "service-dev-password";
const host = process.env.PGHOST || "127.0.0.1";
const port = process.env.PGPORT || "5432";
const dbName = process.env.DATABASE_NAME || "treasury_dev";

function dbUrl(role) {
  return `postgres://${role}:${serviceDbPassword}@${host}:${port}/${dbName}`;
}

const processes = [
  ["wallet-service", "services/wallet-service/src/index.mjs", { PORT: "4101", DATABASE_URL: dbUrl("svc_wallet") }],
  ["policy-service", "services/policy-service/src/index.mjs", { PORT: "4102", DATABASE_URL: dbUrl("svc_policy") }],
  ["compliance-service", "services/compliance-service/src/index.mjs", { PORT: "4103", DATABASE_URL: dbUrl("svc_compliance") }],
  ["accounting-service", "services/accounting-service/src/index.mjs", { PORT: "4105", DATABASE_URL: dbUrl("svc_accounting") }],
  ["reconciliation-service", "services/reconciliation-service/src/index.mjs", { PORT: "4106", DATABASE_URL: dbUrl("svc_reconciliation") }],
  ["operations-service", "services/operations-service/src/index.mjs", { PORT: "4107", DATABASE_URL: dbUrl("svc_operations") }],
  ["payment-service", "services/payment-service/src/index.mjs", { PORT: "4104", DATABASE_URL: dbUrl("svc_payment") }],
  ["api-gateway", "services/api-gateway/src/index.mjs", { GATEWAY_PORT: "8080", DATABASE_URL: dbUrl("svc_gateway") }],
  ["relay-worker", "services/relay-worker/src/index.mjs", { PORT: "9101", DATABASE_URL: dbUrl("svc_relay") }],
  ["job-worker", "services/job-worker/src/index.mjs", { PORT: "9102", DATABASE_URL: dbUrl("svc_job") }]
];

const children = processes.map(([name, script, env]) => {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${name}] exited with ${signal || code}`);
      shutdown(code || 1);
    }
  });
  return child;
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Microservices dev stack starting. Gateway: http://127.0.0.1:8080");

function writePrefixed(name, chunk) {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    console.log(`[${name}] ${line}`);
  }
}

function shutdown(exitCode) {
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250);
}
