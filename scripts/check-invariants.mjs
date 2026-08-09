// scripts/check-invariants.mjs
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgres://127.0.0.1:5432/treasury_dev" });
await client.connect();
const checks = [
  ["negative balances", `SELECT count(*)::int AS n FROM wallet.wallet_balances WHERE balance < 0`],
  ["unbalanced ledger transactions", `
    SELECT count(*)::int AS n FROM (
      SELECT lt.id FROM wallet.ledger_transactions lt
      JOIN wallet.ledger_entries le ON le.transaction_id = lt.id
      GROUP BY lt.id
      HAVING SUM(CASE WHEN le.direction='debit' THEN le.amount ELSE -le.amount END) <> 0
    ) t`],
  ["NULL-tenant jobs", `SELECT count(*)::int AS n FROM platform.jobs WHERE tenant_id IS NULL`],
  ["NULL-tenant outbox events", `SELECT count(*)::int AS n FROM platform.outbox_events WHERE tenant_id IS NULL`],
  ["approvals integrity", `
    SELECT count(*)::int AS n FROM payment.payments p
    WHERE p.approvals > (SELECT COUNT(DISTINCT approver_id)
                         FROM payment.payment_approvals a WHERE a.payment_id = p.id)`]
];
let failed = false;
for (const [name, sql] of checks) {
  const { rows } = await client.query(sql);
  if (rows[0].n !== 0) { failed = true; console.error(`INVARIANT VIOLATION: ${name} (${rows[0].n})`); }
  else { console.log(`ok: ${name}`); }
}
await client.end();
if (failed) process.exit(1);
console.log("all DB invariants clean");
