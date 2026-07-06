// Verify the tamper-evident audit hash chain (V6 Epic 3).
//
// Walks every tenant's chain in operations.audit_events, recomputes every row hash with the
// canonical SQL serialization, and checks prev-hash linkage and chain_seq continuity.
//
// Usage:
//   node scripts/verify-audit-chain.mjs            # against DATABASE_URL (default treasury_dev)
//   DATABASE_URL=postgres://... node scripts/verify-audit-chain.mjs
//
// Exit code 0: every chain intact. Exit code 1: break found — the JSON output names the
// first broken row (id, tenantId, chainSeq, reason). See docs/RUNBOOKS.md "Audit chain break".

import { verifyAuditChain } from "../packages/shared/audit.mjs";
import { closeAllPools } from "../packages/shared/db.mjs";

let result;
try {
  result = await verifyAuditChain("operations");
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  await closeAllPools();
  process.exit(1);
}

console.log(JSON.stringify(result));
await closeAllPools();
process.exit(result.ok ? 0 : 1);
