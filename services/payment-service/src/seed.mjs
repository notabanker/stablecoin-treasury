import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedPayments(tenantId = DEFAULT_TENANT_ID) {
  const { payments } = createSeedData(tenantId);
  await withTransaction("payment", async (client) => {
    // Deletes run under owner privileges via SECURITY DEFINER function (migration 0055)
    await client.query("SELECT payment.reset_seed($1)", [tenantId]);

    for (const payment of payments) {
      await client.query(
        `INSERT INTO payment.payments
           (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result, provider_ref, chain_ref, memo, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          payment.id,
          tenantId,
          payment.reference,
          payment.type,
          payment.sourceWalletId,
          payment.counterpartyId,
          payment.asset,
          payment.amount,
          payment.fee,
          payment.status,
          payment.approvals,
          payment.requiredApprovals,
          payment.screenResult,
          payment.providerRef || "",
          payment.chainRef || "",
          payment.memo || "",
          payment.createdAt,
          payment.settledAt || null
        ]
      );
      // Seeded approval counts need matching approval rows or the approvals-integrity
      // invariant (distinct approval rows >= approvals count) breaks on every demo reset.
      // Mirrors the migration 0031 backfill marker pattern.
      for (let i = 1; i <= (payment.approvals || 0); i += 1) {
        await client.query(
          `INSERT INTO payment.payment_approvals (tenant_id, payment_id, approver_id, approver_display)
           VALUES ($1, $2, $3, 'Seeded demo approval')
           ON CONFLICT (payment_id, approver_id) DO NOTHING`,
          [tenantId, payment.id, `seed:demo:${i}`]
        );
      }
    }
  }, { tenantId });
}
