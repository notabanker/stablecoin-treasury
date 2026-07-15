import { createId } from "../../../packages/shared/data.mjs";
import { query, withTransaction, runWithTenant } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { enqueueJobInTx } from "../../../packages/shared/jobs.mjs";
import { withInboxDedup } from "../../../packages/shared/outbox.mjs";
import { serviceGet } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "../../../packages/shared/tenant.mjs";
import { validateProductionConfig } from "../../../packages/shared/config.mjs";
import { reseedReconciliation } from "./seed.mjs";

const port = Number(process.env.PORT || 4106);
const DB = "reconciliation";

validateProductionConfig("reconciliation-service");
// Bootstrap runs outside any request: enter the default-tenant RLS context explicitly
// so the seeded-data existence check does not fail closed (0 rows) and reseed every boot.
await runWithTenant(DEFAULT_TENANT_ID, bootstrap);

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
    route("POST", "/reset", async ({ headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      await reseedReconciliation(tenantId);
      return ok(await listReconciliation(tenantId));
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
      const inserted = await withInboxDedup(DB, headers, "reconciliation", async (client) => insertRow(row, tenantId, client));
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
    // ── Provider statement ingestion + matching (V6 Epic 5.2) ──
    route("GET", "/statements", async ({ headers }) => ok(await listStatements(tenantIdFromHeaders(headers)))),
    route("POST", "/statements", async ({ body, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      return ok(await ingestStatement(body, tenantId));
    }),
    route("POST", "/statements/:id/match", async ({ params, headers }) => {
      const tenantId = tenantIdFromHeaders(headers);
      return ok(await matchStatement(params.id, tenantId));
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

// ── Provider statements (V6 Epic 5.2) ──────────────────────────────────

// V6 Epic 5.2 — ProviderId tenant validation: reject statements for providerIds
// that belong to a different tenant (audit finding M8).
// The provider is resolved by id only, but we verify its tenant matches the request's
// tenant context by checking it exists in operations.providers under that tenant.
async function ingestStatement(body, tenantId) {
  const { providerId, externalId, periodStart, periodEnd, lines } = body || {};
  if (!providerId || !externalId) {
    throw httpError(422, "providerId and externalId are required", "missing_statement_identity");
  }
  // Verify the provider belongs to the calling tenant
  const { rows: providerRows } = await query(
    "operations",
    "SELECT id FROM operations.providers WHERE id = $1 AND tenant_id = $2 LIMIT 1",
    [providerId, tenantId]
  );
  if (!providerRows[0]) {
    throw httpError(403, "Provider not found or not accessible for this tenant", "provider_tenant_mismatch");
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw httpError(422, "Statement must contain at least one line", "missing_lines");
  }
  for (const line of lines) {
    if (!line.providerRef || !Number.isFinite(Number(line.amount)) || !line.asset) {
      throw httpError(422, "Every line needs providerRef, finite amount, and asset", "invalid_line");
    }
  }

  let statement;
  try {
    statement = await withTransaction(DB, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO reconciliation.provider_statements (tenant_id, provider_id, external_id, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [tenantId, providerId, externalId, periodStart || null, periodEnd || null]
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO reconciliation.statement_lines (tenant_id, statement_id, provider_ref, amount, asset, occurred_at, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, rows[0].id, line.providerRef, Number(line.amount), line.asset, line.occurredAt || null, JSON.stringify(line.raw || {})]
        );
      }
      // Enqueue the match job inside the same transaction so that a crash after commit
      // guarantees the job exists; a crash before commit rolls back everything.
      await enqueueJobInTx(client, "match-statement", { statementId: rows[0].id }, { tenantId, maxAttempts: 3 });
      return rows[0];
    });
  } catch (error) {
    if (error.code === "23505") {
      // Idempotent re-delivery: the statement (provider_id, external_id) already exists.
      return { status: "duplicate", providerId, externalId };
    }
    throw error;
  }

  return { status: "ingested", statementId: statement.id, lines: lines.length };
}

async function listStatements(tenantId = DEFAULT_TENANT_ID) {
  const { rows } = await query(
    DB,
    `SELECT s.*, COUNT(l.id)::int AS line_count,
            COUNT(l.id) FILTER (WHERE l.match_status = 'matched')::int AS matched_count,
            COUNT(l.id) FILTER (WHERE l.match_status = 'exception')::int AS exception_count
       FROM reconciliation.provider_statements s
       LEFT JOIN reconciliation.statement_lines l ON l.statement_id = s.id
      WHERE s.tenant_id = $1
      GROUP BY s.id
      ORDER BY s.received_at DESC`,
    [tenantId]
  );
  return rows.map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    externalId: row.external_id,
    receivedAt: row.received_at.toISOString(),
    lineCount: row.line_count,
    matchedCount: row.matched_count,
    exceptionCount: row.exception_count
  }));
}

// Match every pending line of a statement against payments (fetched over HTTP — the
// reconciliation role deliberately has no grant on the payment schema).
// Categories: exact provider_ref match (confidence 1.00), heuristic amount+asset+day
// (0.70), fee_mismatch, amount_mismatch, duplicate, missing_ours; plus missing_theirs
// for settled payments inside the statement period that appear on no line.
async function matchStatement(statementId, tenantId) {
  const { rows: stmtRows } = await query(
    DB, "SELECT * FROM reconciliation.provider_statements WHERE id = $1 AND tenant_id = $2",
    [statementId, tenantId]
  );
  if (!stmtRows[0]) {
    throw httpError(404, `statement ${statementId} not found`, "not_found");
  }
  const statement = stmtRows[0];

  const { rows: lines } = await query(
    DB,
    "SELECT * FROM reconciliation.statement_lines WHERE statement_id = $1 AND tenant_id = $2 AND match_status = 'pending' ORDER BY provider_ref",
    [statementId, tenantId]
  );
  const payments = await serviceGet("payment", "/payments", { tenantId });
  const byProviderRef = new Map(payments.filter((p) => p.providerRef).map((p) => [p.providerRef, p]));

  const summary = { matched: 0, exceptions: 0, byCategory: {} };
  const bump = (category) => { summary.byCategory[category] = (summary.byCategory[category] || 0) + 1; };

  const setLine = (client, lineId, status, confidence) => client.query(
    "UPDATE reconciliation.statement_lines SET match_status = $1, match_confidence = $2 WHERE id = $3 AND tenant_id = $4",
    [status, confidence, lineId, tenantId]
  );

  const openException = async (client, paymentId, issue, amount, asset, category) => {
    await insertRow({
      id: createId("rec"),
      paymentId,
      source: "Provider statement",
      issue,
      amount,
      asset,
      status: "Open",
      owner: "Treasury Ops"
    }, tenantId, client);
    summary.exceptions += 1;
    bump(category);
  };

  const markMatched = async (client, line, payment, confidence) => {
    // A settled payment usually already has a Matched row from our own event flow; the
    // statement CONFIRMS it (the matched-once-per-payment unique index stays intact).
    const { rows: existing } = await client.query(
      "SELECT id FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = 'Matched'",
      [tenantId, payment.id]
    );
    if (!existing[0]) {
      await insertRow({
        id: createId("rec"),
        paymentId: payment.id,
        source: "Provider statement",
        issue: "Matched",
        amount: Number(line.amount),
        asset: line.asset,
        status: "Resolved",
        owner: "Auto"
      }, tenantId, client);
    }
    await setLine(client, line.id, "matched", confidence);
    summary.matched += 1;
    bump(confidence >= 1 ? "exact" : "heuristic");
  };

  const matchedRefs = new Set();
  await withTransaction(DB, async (client) => {
  for (const line of lines) {
    // duplicate: this provider_ref was already matched by an earlier line (this run or a
    // previous statement).
    const { rows: dupRows } = await client.query(
      "SELECT COUNT(*)::int AS count FROM reconciliation.statement_lines WHERE tenant_id = $1 AND provider_ref = $2 AND match_status = 'matched'",
      [tenantId, line.provider_ref]
    );
    if (dupRows[0].count > 0 || matchedRefs.has(line.provider_ref)) {
      await setLine(client, line.id, "exception", null);
      await openException(client, `stmt:${line.id}`, "Duplicate statement line for already-matched transfer", Number(line.amount), line.asset, "duplicate");
      continue;
    }

    const payment = byProviderRef.get(line.provider_ref);
    if (payment) {
      const lineAmount = Number(line.amount);
      const payAmount = Number(payment.amount);
      const fee = Number(payment.fee || 0);
      if (lineAmount === payAmount) {
        await markMatched(client, line, payment, 1.0);
        matchedRefs.add(line.provider_ref);
      } else if (Math.abs(lineAmount - (payAmount + fee)) < 0.005 || Math.abs(lineAmount - (payAmount - fee)) < 0.005) {
        await setLine(client, line.id, "exception", null);
        await openException(client, payment.id, "Fee amount differs from provider statement", Math.abs(lineAmount - payAmount), line.asset, "fee_mismatch");
      } else {
        await setLine(client, line.id, "exception", null);
        await openException(client, payment.id, "Amount differs from provider statement", lineAmount, line.asset, "amount_mismatch");
      }
      continue;
    }

    // heuristic: same asset + same amount + settled the same day, not already claimed.
    const heuristic = payments.find((p) =>
      p.status === "Settled" &&
      p.asset === line.asset &&
      Number(p.amount) === Number(line.amount) &&
      !matchedRefs.has(p.providerRef) &&
      line.occurred_at && p.settledAt &&
      new Date(p.settledAt).toISOString().slice(0, 10) === new Date(line.occurred_at).toISOString().slice(0, 10)
    );
    if (heuristic) {
      await markMatched(client, line, heuristic, 0.7);
      matchedRefs.add(heuristic.providerRef);
      continue;
    }

    await setLine(client, line.id, "exception", null);
    await openException(client, `stmt:${line.id}`, "Statement line has no matching payment", Number(line.amount), line.asset, "missing_ours");
  }

  // missing_theirs: only when the statement declares a period — settled payments inside
  // it that appear on no line of this statement.
  if (statement.period_start && statement.period_end) {
    const lineRefs = new Set((await client.query(
      "SELECT provider_ref FROM reconciliation.statement_lines WHERE statement_id = $1 AND tenant_id = $2",
      [statementId, tenantId]
    )).rows.map((r) => r.provider_ref));
    for (const payment of payments) {
      if (payment.status !== "Settled" || !payment.settledAt || !payment.providerRef) continue;
      const settled = new Date(payment.settledAt);
      if (settled >= new Date(statement.period_start) && settled <= new Date(statement.period_end) && !lineRefs.has(payment.providerRef)) {
        await openException(client, payment.id, "Settled payment missing from provider statement", Number(payment.amount), payment.asset, "missing_theirs");
      }
    }
  }

  }); // end withTransaction
  return { statementId, ...summary };
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM reconciliation.reconciliation_rows WHERE tenant_id = $1", [
    DEFAULT_TENANT_ID
  ]);
  if (rows[0].count === 0) {
    await reseedReconciliation();
  }
}
