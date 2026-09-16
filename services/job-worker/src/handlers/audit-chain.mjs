import { verifyAuditChain } from "../../../../packages/shared/audit.mjs";
import { query } from "../../../../packages/shared/db.mjs";
import { logError } from "../../../../packages/shared/log.mjs";

const ALERT_TITLE = "Audit chain integrity violation";

// Recomputes every audit row hash and checks per-tenant linkage/continuity. On break: one Open
// alert per broken tenant (deduped like watchdog alerts). When the chain is intact, open chain
// alerts are closed (e.g. after a demo reset rebuilt the chain).
export async function verifyChains() {
  const result = await verifyAuditChain("operations");
  if (result.ok) {
    await query("operations",
      "UPDATE operations.alerts SET status = 'Closed' WHERE title = $1 AND status = 'Open'",
      [ALERT_TITLE]
    );
    return;
  }

  const broken = result.break;
  logError("audit_chain_break", broken.reason, { ...broken });
  const { rows: existing } = await query("operations",
    "SELECT id FROM operations.alerts WHERE tenant_id = $1 AND title = $2 AND status = 'Open' LIMIT 1",
    [broken.tenantId, ALERT_TITLE]
  );
  if (existing[0]) return;

  await query("operations",
    `INSERT INTO operations.alerts (id, tenant_id, severity, title, detail, status)
     VALUES ($1, $2, 'High', $3, $4, 'Open')`,
    [
      `ac-${Date.now().toString(36)}`,
      broken.tenantId,
      ALERT_TITLE,
      `${broken.reason} at chain_seq ${broken.chainSeq} (event ${broken.id}). See docs/RUNBOOKS.md "Audit chain break".`
    ]
  );
}
