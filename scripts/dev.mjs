import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES } from "../packages/shared/services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let shuttingDown = false;

const serviceDbPassword = process.env.SERVICE_DB_PASSWORD || "service-dev-password";
const host = process.env.PGHOST || "127.0.0.1";
const port = process.env.PGPORT || "5432";
const dbName = process.env.DATABASE_NAME || "treasury_dev";

function dbUrl(role) {
  return `postgres://${role}:${serviceDbPassword}@${host}:${port}/${dbName}`;
}

const children = SERVICES.map(({ name, path, env, port: servicePort, role }) => {
  const child = spawn(process.execPath, [path], {
    cwd: root,
    env: { ...process.env, [env]: String(servicePort), DATABASE_URL: dbUrl(role) },
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
