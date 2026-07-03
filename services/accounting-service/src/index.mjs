import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { assertBalanced, createPaymentJournals } from "./journals.mjs";
import { reseedJournals } from "./seed.mjs";

const port = Number(process.env.PORT || 4105);
const DB = "accounting";

await bootstrap();

createJsonService({
  name: "accounting-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "accounting-service" })),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }),
    route("POST", "/reset", async () => {
      await reseedJournals();
      return ok(await listJournals());
    }),
    route("GET", "/journals", async () => ok(await listJournals())),
    route("POST", "/journals/from-payment", async ({ body }) => {
      if (!body.payment || !body.entity || !body.asset) {
        throw httpError(422, "Payment, entity, and asset are required", "missing_context");
      }
      const { rows: existing } = await query(DB, "SELECT * FROM accounting.journal_entries WHERE payment_id = $1", [body.payment.id]);
      if (existing.length) {
        return ok(existing.map(toApiShape));
      }
      const entries = createPaymentJournals(body.payment, body.wallet, body.entity, body.asset);
      // Fast-fail in the app before round-tripping to the database; the deferred constraint
      // trigger on accounting.journal_entries (0006_accounting.sql) is the actual source of
      // truth and will reject the transaction at COMMIT even if this check is ever bypassed.
      assertBalanced(entries);
      try {
        await withTransaction(DB, async (client) => {
          for (const entry of entries) {
            await client.query(
              `INSERT INTO accounting.journal_entries (id, tenant_id, date, entity_id, payment_id, account, debit, credit, currency, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [entry.id, DEFAULT_TENANT_ID, entry.date, entry.entityId, entry.paymentId, entry.account, entry.debit, entry.credit, entry.currency, entry.status]
            );
          }
        });
      } catch (error) {
        // 23505 = unique_violation on journal_entries_payment_account_uniq (0009): a concurrent
        // call already inserted this payment's batch between our existence check and our insert.
        // Treat it the same as finding the existing rows up front.
        if (error.code === "23505") {
          const { rows: raced } = await query(DB, "SELECT * FROM accounting.journal_entries WHERE payment_id = $1", [body.payment.id]);
          return ok(raced.map(toApiShape));
        }
        throw error;
      }
      return ok(entries);
    }),
    route("POST", "/journals/export", async () => {
      await query(DB, "UPDATE accounting.journal_entries SET status = 'Exported' WHERE tenant_id = $1 AND status = 'Ready'", [
        DEFAULT_TENANT_ID
      ]);
      return ok(await listJournals());
    })
  ]
});

function toApiShape(row) {
  return {
    id: row.id,
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
    entityId: row.entity_id,
    paymentId: row.payment_id,
    account: row.account,
    debit: Number(row.debit),
    credit: Number(row.credit),
    currency: row.currency,
    status: row.status
  };
}

async function listJournals() {
  const { rows } = await query(DB, "SELECT * FROM accounting.journal_entries WHERE tenant_id = $1 ORDER BY created_at DESC", [
    DEFAULT_TENANT_ID
  ]);
  return rows.map(toApiShape);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM accounting.journal_entries WHERE tenant_id = $1", [
    DEFAULT_TENANT_ID
  ]);
  if (rows[0].count === 0) {
    await reseedJournals();
  }
}
