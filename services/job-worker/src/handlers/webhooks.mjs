import { query } from "../../../../packages/shared/db.mjs";
import { logEvent } from "../../../../packages/shared/log.mjs";
import { serviceGet, servicePost } from "../../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../../packages/shared/tenant.mjs";

export async function processSettlementWebhook(job) {
  const { providerId, eventId, paymentRef } = job.payload;
  const tenantId = job.tenant_id || job.payload.tenantId || DEFAULT_TENANT_ID;
  logEvent("webhook_processing", { providerId, eventId, paymentRef });

  await query(
    "platform",
    "UPDATE platform.webhook_events SET status = 'processed', processed_at = now() WHERE provider_id = $1 AND external_id = $2 AND tenant_id = $3",
    [providerId, eventId, tenantId]
  );

  // Audit finding #4: a settlement webhook is the provider's confirmation that the transfer
  // settled — re-run the matcher for every statement that references it, so a line that was
  // unmatched when its statement job ran (the payment carried no provider ref yet) can now
  // resolve. Orchestrated over HTTP like the match-statement job: the worker has no direct
  // grants on the reconciliation tables (migration 0049), and the filters ride headers
  // because internal-auth signatures cover the pathname only.
  if (!paymentRef) return;
  const statements = await serviceGet("reconciliation", "/statements", {
    tenantId,
    headers: { "X-Provider-Ref": paymentRef, "X-Provider-Id": providerId }
  });
  for (const statement of statements) {
    await servicePost("reconciliation", `/statements/${statement.id}/match`, {}, { tenantId });
  }
  if (statements.length > 0) {
    logEvent("reconciliation_match_triggered", { providerId, paymentRef, statements: statements.length });
  }
}

// The job worker orchestrates over HTTP: the reconciliation role owns its schema; the worker
// never touches reconciliation tables directly.
export async function matchStatement(job) {
  const tenantId = job.tenant_id || job.payload.tenantId || DEFAULT_TENANT_ID;
  await servicePost("reconciliation", `/statements/${job.payload.statementId}/match`, {}, { tenantId });
}
