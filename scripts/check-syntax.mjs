import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set(["node_modules", ".git", ".data"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
    } else if (extname(name) === ".mjs" || full.endsWith("apps/web/main.js")) {
      files.push(full);
    }
  }
})(root);

let failed = false;
for (const file of files.sort()) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed = true;
    console.error(`SYNTAX ERROR: ${file}`);
    console.error(error.stderr.toString());
  }
}

if (failed) {
  process.exit(1);
}
console.log(`checked ${files.length} files, no syntax errors`);
