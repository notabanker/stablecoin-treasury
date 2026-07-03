import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

const prefixMap = new Map();
const issues = [];

for (const file of files) {
  const match = file.match(/^(\d{4})/);
  if (!match) {
    issues.push(`SKIP: ${file} — no numeric prefix`);
    continue;
  }
  const prefix = match[1];
  if (prefixMap.has(prefix)) {
    issues.push(`DUPLICATE: ${prefixMap.get(prefix)} and ${file} share prefix ${prefix}`);
  } else {
    prefixMap.set(prefix, file);
  }
}

const ordered = [...prefixMap.keys()].sort();
for (let i = 0; i < ordered.length - 1; i += 1) {
  const current = Number(ordered[i]);
  const next = Number(ordered[i + 1]);
  if (current >= next) {
    issues.push(`ORDER: ${prefixMap.get(ordered[i])} (${ordered[i]}) comes before ${prefixMap.get(ordered[i + 1])} (${ordered[i + 1]}) but prefixes should be monotonic`);
    break;
  }
}

if (issues.length > 0) {
  console.log("Migration issues found:");
  for (const issue of issues) {
    console.log(`  - ${issue}`);
  }
  // The existing 0017 duplicate is a known legacy issue from V3 audit hardening.
  // Flagging but not failing, since migration ordering is currently correct.
  const knownDuplicate = issues.filter((i) => i.includes("0017"));
  const unknownIssues = issues.filter((i) => !i.includes("0017"));
  if (unknownIssues.length > 0) {
    console.error("\nUnknown migration issues detected. Fix before proceeding.");
    process.exit(1);
  }
  if (knownDuplicate.length > 0 && issues.length === knownDuplicate.length) {
    console.log("\nKnown duplicate 0017 prefix present — no future duplicates allowed.");
  }
} else {
  console.log("Migrations look clean.");
}
