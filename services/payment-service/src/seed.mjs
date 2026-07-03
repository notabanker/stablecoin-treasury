import { createSeedData } from "../../../packages/shared/data.mjs";
import { withTransaction } from "../../../packages/shared/db.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";

export async function reseedPayments() {
  const { payments } = createSeedData();
  await withTransaction("payment", async (client) => {
    await client.query("DELETE FROM payment.idempotency_keys WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM payment.payment_events WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    await client.query("DELETE FROM payment.payments WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
    // Reset the reference sequence so a fresh demo run produces the same seeded-looking
    // references as before; RESTART is safe here because this only runs on /reset, never
    // concurrently with live traffic against the same tenant in this single-tenant prototype.
    await client.query("ALTER SEQUENCE payment.payment_reference_seq RESTART WITH 1005");

    for (const payment of payments) {
      await client.query(
        `INSERT INTO payment.payments
           (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result, provider_ref, chain_ref, memo, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          payment.id,
          DEFAULT_TENANT_ID,
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
    }
  });
}
