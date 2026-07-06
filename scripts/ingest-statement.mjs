// File-drop ingestion for provider statements (V6 Epic 5.2).
//
// Usage:
//   node scripts/ingest-statement.mjs path/to/statement.json
//
// Statement file shape:
//   {
//     "providerId": "prov-arcadia",
//     "externalId": "stmt-2026-07-01",
//     "periodStart": "2026-07-01T00:00:00Z",   // optional
//     "periodEnd": "2026-07-31T23:59:59Z",     // optional
//     "lines": [ { "providerRef": "ARC-...", "amount": 100, "asset": "EURC", "occurredAt": "..." } ]
//   }
//
// Env: RECONCILIATION_SERVICE_URL (default http://127.0.0.1:4106), TENANT_ID (default
// tenant 1), INTERNAL_AUTH_REQUIRED/INTERNAL_SERVICE_TOKEN honored via request signing.

import { readFileSync } from "node:fs";
import { signInternalRequest } from "../packages/shared/http.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/ingest-statement.mjs <statement.json>");
  process.exit(2);
}

const baseUrl = process.env.RECONCILIATION_SERVICE_URL || "http://127.0.0.1:4106";
const tenantId = process.env.TENANT_ID || "00000000-0000-0000-0000-000000000001";
const body = JSON.parse(readFileSync(file, "utf8"));
const path = "/statements";

const response = await fetch(`${baseUrl}${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Tenant-Id": tenantId,
    ...signInternalRequest("POST", path, body)
  },
  body: JSON.stringify(body)
});

const result = await response.json();
console.log(JSON.stringify({ status: response.status, ...result }));
process.exit(response.ok ? 0 : 1);
