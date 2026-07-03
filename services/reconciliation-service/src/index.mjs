import { createId } from "../../../packages/shared/data.mjs";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { claimInboxEvent } from "../../../packages/shared/outbox.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { reseedReconciliation } from "./seed.mjs";

const port = Number(process.env.PORT || 4106);
const DB = "reconciliation";

validateProductionConfig("reconciliation-service");
await bootstrap();

createJsonService({
  name: "reconciliation-service",
  port,
  internalAuthRequired: true,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "reconciliation-service" }), { public: true }),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    route("POST", "/reset", async () => {
      await reseedReconciliation();
      return ok(await listReconciliation());
    }),
    route("GET", "/reconciliation", async ({ headers }) => ok(await listReconciliation(tenantIdFromHeaders(headers)))),
    route("POST", "/reconciliation/matched", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const { rows: existingRows } = await query(
        DB,
        "SELECT * FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = 'Matched'",
        [tenantId, payment.id]
      );
      if (existingRows[0]) {
        return ok(withComputedAge(existingRows[0]));
      }
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
        const inserted = await insertRow(row, tenantId);
        return ok(withComputedAge(inserted));
      } catch (error) {
        // 23505 = unique_violation on reconciliation_rows_matched_once_per_payment (0009): a
        // concurrent call already inserted the Matched row between our existence check and ours.
        if (error.code === "23505") {
          const { rows: raced } = await query(
            DB,
            "SELECT * FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = 'Matched'",
            [tenantId, payment.id]
          );
          return ok(withComputedAge(raced[0]));
        }
        throw error;
      }
    }),
    route("POST", "/reconciliation/exceptions", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const row = {
        id: createId("rec"),
        paymentId: payment.id,
        source: body.source || "Policy engine",
        issue: body.issue || "Manual exception",
        amount: Number(body.amount ?? payment.amount),
        asset: body.asset || payment.asset,
        status: "Open",
        owner: body.owner || "Treasury Ops"
      };
      const inserted = await withInboxDedup(headers, "reconciliation", async (client) => insertRow(row, tenantId, client));
      if (inserted.duplicate) {
        return ok(inserted);
      }
      return ok(withComputedAge(inserted));
    }),
    route("POST", "/reconciliation/exceptions/simulate", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
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
      const inserted = await insertRow(row, tenantId);
      return ok(withComputedAge(inserted));
    }),
    route("POST", "/reconciliation/:id/resolve", async ({ params, body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
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

async function insertRow(row, tenantId = DEFAULT_TENANT_ID, client = null) {
  const q = client || { query: (...args) => query(DB, ...args) };
  const { rows } = await q.query(
    `INSERT INTO reconciliation.reconciliation_rows (id, tenant_id, payment_id, source, issue, amount, asset, status, owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [row.id, tenantId, row.paymentId, row.source, row.issue, row.amount, row.asset, row.status, row.owner]
  );
  return rows[0];
}

async function withInboxDedup(headers, consumer, handler) {
  const eventId = headers["x-event-id"];
  if (!eventId) {
    return handler();
  }
  return withTransaction(DB, async (client) => {
    const shouldProcess = await claimInboxEvent(client, eventId, consumer);
    if (!shouldProcess) return { duplicate: true, eventId };
    return handler(client);
  });
}

function withComputedAge(row) {
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const endedAt = row.resolved_at ? new Date(row.resolved_at) : new Date();
  const ageHours = Math.max(0, (endedAt.getTime() - createdAt.getTime()) / 3_600_000);
  return {
    id: row.id,
    paymentId: row.payment_id,
    source: row.source,
    issue: row.issue,
    amount: Number(row.amount),
    asset: row.asset,
    status: row.status,
    owner: row.owner,
    createdAt: createdAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10
  };
}

async function listReconciliation(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(DB, "SELECT * FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 ORDER BY created_at DESC", [
    tenantId
  ]);
  return rows.map(withComputedAge);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM reconciliation.reconciliation_rows WHERE tenant_id = $1", [
    DEFAULT_TENANT_ID
  ]);
  if (rows[0].count === 0) {
    await reseedReconciliation();
  }
}
