import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let shuttingDown = false;

const processes = [
  ["wallet-service", "services/wallet-service/src/index.mjs", { PORT: "4101" }],
  ["policy-service", "services/policy-service/src/index.mjs", { PORT: "4102" }],
  ["compliance-service", "services/compliance-service/src/index.mjs", { PORT: "4103" }],
  ["accounting-service", "services/accounting-service/src/index.mjs", { PORT: "4105" }],
  ["reconciliation-service", "services/reconciliation-service/src/index.mjs", { PORT: "4106" }],
  ["operations-service", "services/operations-service/src/index.mjs", { PORT: "4107" }],
  ["payment-service", "services/payment-service/src/index.mjs", { PORT: "4104" }],
  ["api-gateway", "services/api-gateway/src/index.mjs", { GATEWAY_PORT: "8080" }],
  ["relay-worker", "services/relay-worker/src/index.mjs", { PORT: "9101" }],
  ["job-worker", "services/job-worker/src/index.mjs", { PORT: "9102" }]
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
