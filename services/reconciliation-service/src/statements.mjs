import { createId } from "../../../packages/shared/data.mjs";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { httpError } from "../../../packages/shared/http.mjs";
import { enqueueJobInTx } from "../../../packages/shared/jobs.mjs";
import { moneyNumber } from "../../../packages/shared/money.mjs";
import { serviceGet } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { insertRow } from "./store.mjs";

const DB = "reconciliation";

export async function ingestStatement(body, tenantId) {
  const { providerId, externalId, periodStart, periodEnd, lines } = body || {};
  if (!providerId || !externalId) {
    throw httpError(422, "providerId and externalId are required", "missing_statement_identity");
  }
  // V6 Epic 5.2 (audit finding M8): the provider is resolved by id, so verify it belongs to
  // the calling tenant before accepting anything for it.
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
    if (!line.providerRef || !Number.isFinite(moneyNumber(line.amount)) || !line.asset) {
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
          [tenantId, rows[0].id, line.providerRef, moneyNumber(line.amount), line.asset, line.occurredAt || null, JSON.stringify(line.raw || {})]
        );
      }
      // Enqueue the match job in the same transaction: a crash before commit rolls back
      // everything, a crash after commit guarantees the job exists.
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

export async function listStatements(tenantId = DEFAULT_TENANT_ID, providerRef = null, providerId = null) {
  const { rows } = await query(
    DB,
    `SELECT s.*, COUNT(l.id)::int AS line_count,
            COUNT(l.id) FILTER (WHERE l.match_status = 'matched')::int AS matched_count,
            COUNT(l.id) FILTER (WHERE l.match_status = 'exception')::int AS exception_count
       FROM reconciliation.provider_statements s
       LEFT JOIN reconciliation.statement_lines l ON l.statement_id = s.id
      WHERE s.tenant_id = $1
        AND ($2::text IS NULL OR EXISTS (
              SELECT 1 FROM reconciliation.statement_lines l2
               WHERE l2.statement_id = s.id AND l2.tenant_id = s.tenant_id AND l2.provider_ref = $2))
        AND ($3::text IS NULL OR s.provider_id = $3)
      GROUP BY s.id
      ORDER BY s.received_at DESC`,
    [tenantId, providerRef, providerId]
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

// Match every pending/exception line of a statement against payments (fetched over HTTP —
// the reconciliation role deliberately has no grant on the payment schema).
// Categories: exact provider_ref match (confidence 1.00), heuristic amount+asset+day (0.70),
// fee_mismatch, amount_mismatch, duplicate, missing_ours; plus missing_theirs for settled
// payments inside the statement period that appear on no line.
export async function matchStatement(statementId, tenantId) {
  const { rows: stmtRows } = await query(
    DB, "SELECT * FROM reconciliation.provider_statements WHERE id = $1 AND tenant_id = $2",
    [statementId, tenantId]
  );
  if (!stmtRows[0]) {
    throw httpError(404, `statement ${statementId} not found`, "not_found");
  }
  const statement = stmtRows[0];

  // pending AND exception: the settlement webhook re-runs this matcher for statements that
  // reference a settled transfer (audit finding #4) — a line that was unmatched (exception)
  // when its ingest job ran can now resolve once the payment carries the ref.
  const { rows: lines } = await query(
    DB,
    "SELECT * FROM reconciliation.statement_lines WHERE statement_id = $1 AND tenant_id = $2 AND match_status IN ('pending', 'exception') ORDER BY provider_ref",
    [statementId, tenantId]
  );
  const payments = await serviceGet("payment", "/payments", { tenantId });
  const byProviderRef = new Map(payments.filter((p) => p.providerRef).map((p) => [p.providerRef, p]));
  const summary = { matched: 0, exceptions: 0, byCategory: {} };
  const matchedRefs = new Set();

  const setLine = (client, lineId, status, confidence) => client.query(
    "UPDATE reconciliation.statement_lines SET match_status = $1, match_confidence = $2 WHERE id = $3 AND tenant_id = $4",
    [status, confidence, lineId, tenantId]
  );

  const openException = async (client, paymentId, issue, amount, asset, category) => {
    // Re-matching re-examines exception lines; keep one Open row per (payment, issue) instead
    // of stacking duplicates on every re-run.
    const { rows: existing } = await client.query(
      "SELECT id FROM reconciliation.reconciliation_rows WHERE tenant_id = $1 AND payment_id = $2 AND issue = $3 AND status = 'Open' LIMIT 1",
      [tenantId, paymentId, issue]
    );
    if (existing[0]) return;
    await insertRow({ id: createId("rec"), paymentId, source: "Provider statement", issue, amount, asset, status: "Open", owner: "Treasury Ops" }, tenantId, client);
    summary.exceptions += 1;
    summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;
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
        amount: moneyNumber(line.amount),
        asset: line.asset,
        status: "Resolved",
        owner: "Auto"
      }, tenantId, client);
    }
    await setLine(client, line.id, "matched", confidence);
    summary.matched += 1;
    const category = confidence >= 1 ? "exact" : "heuristic";
    summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;
  };

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
        await openException(client, `stmt:${line.id}`, "Duplicate statement line for already-matched transfer", moneyNumber(line.amount), line.asset, "duplicate");
        continue;
      }

      const payment = byProviderRef.get(line.provider_ref);
      if (payment) {
        const lineAmount = moneyNumber(line.amount);
        const payAmount = moneyNumber(payment.amount);
        const fee = moneyNumber(payment.fee || 0);
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
        moneyNumber(p.amount) === moneyNumber(line.amount) &&
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
      await openException(client, `stmt:${line.id}`, "Statement line has no matching payment", moneyNumber(line.amount), line.asset, "missing_ours");
    }

    // missing_theirs: only when the statement declares a period — settled payments inside it
    // that appear on no line of this statement.
    if (statement.period_start && statement.period_end) {
      const lineRefs = new Set((await client.query(
        "SELECT provider_ref FROM reconciliation.statement_lines WHERE statement_id = $1 AND tenant_id = $2",
        [statementId, tenantId]
      )).rows.map((r) => r.provider_ref));
      for (const payment of payments) {
        if (payment.status !== "Settled" || !payment.settledAt || !payment.providerRef) continue;
        const settled = new Date(payment.settledAt);
        if (settled >= new Date(statement.period_start) && settled <= new Date(statement.period_end) && !lineRefs.has(payment.providerRef)) {
          await openException(client, payment.id, "Settled payment missing from provider statement", moneyNumber(payment.amount), payment.asset, "missing_theirs");
        }
      }
    }
  });

  return { statementId, ...summary };
}
