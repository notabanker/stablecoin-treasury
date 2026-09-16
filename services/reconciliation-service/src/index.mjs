import { createId } from "../../../packages/shared/data.mjs";
import { query } from "../../../packages/shared/db.mjs";
import { httpError, ok, route } from "../../../packages/shared/http.mjs";
import { moneyNumber } from "../../../packages/shared/money.mjs";
import { withInboxDedup } from "../../../packages/shared/outbox.mjs";
import { createDomainService } from "../../../packages/shared/service.mjs";
import { reseedReconciliation } from "./seed.mjs";
import { findMatchedRow, insertRow, listReconciliation, withComputedAge } from "./store.mjs";
import { ingestStatement, listStatements, matchStatement } from "./statements.mjs";

const port = Number(process.env.PORT || 4106);
const DB = "reconciliation";

await createDomainService({
  name: "reconciliation-service",
  port,
  db: DB,
  seed: { table: "reconciliation.reconciliation_rows", reseed: reseedReconciliation, list: listReconciliation },
  routes: [
    route("GET", "/reconciliation", async ({ tenantId }) => ok(await listReconciliation(tenantId))),
    route("POST", "/reconciliation/matched", async ({ body, tenantId }) => {
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const existing = await findMatchedRow(tenantId, payment.id);
      if (existing) return ok(withComputedAge(existing));

      const row = {
        id: createId("rec"),
        paymentId: payment.id,
        source: body.source || "On-chain event",
        issue: "Matched",
        amount: payment.amount,
        asset: payment.asset,
        status: "Resolved",
        owner: "Auto"
      };
      try {
        return ok(withComputedAge(await insertRow(row, tenantId)));
      } catch (error) {
        // 23505 = unique_violation on reconciliation_rows_matched_once_per_payment (0009): a
        // concurrent call inserted the Matched row between our existence check and ours.
        if (error.code !== "23505") throw error;
        return ok(withComputedAge(await findMatchedRow(tenantId, payment.id)));
      }
    }),
    route("POST", "/reconciliation/exceptions", async ({ body, headers, tenantId }) => {
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const row = {
        id: createId("rec"),
        paymentId: payment.id,
        source: body.source || "Policy engine",
        issue: body.issue || "Manual exception",
        amount: moneyNumber(body.amount ?? payment.amount),
        asset: body.asset || payment.asset,
        status: "Open",
        owner: body.owner || "Treasury Ops"
      };
      const inserted = await withInboxDedup(DB, headers, "reconciliation", (client) => insertRow(row, tenantId, client));
      return ok(inserted.duplicate ? inserted : withComputedAge(inserted));
    }),
    route("POST", "/reconciliation/exceptions/simulate", async ({ body, tenantId }) => {
      const payment = body.payment;
      if (!payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const row = {
        id: createId("rec"),
        paymentId: payment.id,
        source: "Ledger snapshot",
        issue: "Fee amount differs from provider callback",
        amount: payment.fee || 0,
        asset: payment.asset,
        status: "Open",
        owner: "Treasury Ops"
      };
      return ok(withComputedAge(await insertRow(row, tenantId)));
    }),
    // Optional X-Provider-Ref / X-Provider-Id filters: the settlement-webhook job asks
    // "which statements reference this transfer" before re-running their matcher.
    route("GET", "/statements", async ({ headers, tenantId }) => ok(await listStatements(
      tenantId,
      headers["x-provider-ref"] || null,
      headers["x-provider-id"] || null
    ))),
    route("POST", "/statements", async ({ body, tenantId }) => ok(await ingestStatement(body, tenantId))),
    route("POST", "/statements/:id/match", async ({ params, tenantId }) => ok(await matchStatement(params.id, tenantId))),
    route("POST", "/reconciliation/:id/resolve", async ({ params, body, tenantId }) => {
      const { rows } = await query(
        DB,
        "UPDATE reconciliation.reconciliation_rows SET status = 'Resolved', owner = $1, resolved_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *",
        [body?.owner || "Treasury Ops", params.id, tenantId]
      );
      if (!rows[0]) {
        throw httpError(404, `reconciliation ${params.id} not found`, "not_found");
      }
      return ok(withComputedAge(rows[0]));
    })
  ]
});
