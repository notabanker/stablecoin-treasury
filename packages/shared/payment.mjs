import { moneyNumber } from "./money.mjs";
import { iso, isoOrEmpty } from "./rows.mjs";
import { serviceGet } from "./service-client.mjs";

// Fetch everything the policy engine and the settlement saga need about a payment's
// surrounding context, all over HTTP so no service reaches into another's schema.
export async function getPaymentContext(payment, tenantId) {
  const wallet = await serviceGet("wallet", `/wallets/${payment.sourceWalletId}`, { tenantId });
  const [entity, asset, counterparty, provider, wallets] = await Promise.all([
    serviceGet("wallet", `/entities/${wallet.entityId}`, { tenantId }),
    serviceGet("wallet", `/assets/${payment.asset}`, { tenantId }),
    serviceGet("compliance", `/counterparties/${payment.counterpartyId}`, { tenantId }),
    serviceGet("operations", `/providers/${wallet.providerId}`, { tenantId }),
    serviceGet("wallet", "/wallets", { tenantId })
  ]);
  return { wallet, wallets, entity, asset, counterparty, provider, providerId: wallet.providerId };
}

// Single row -> API shape mapper for payment.payments, shared by the payment service and
// the job worker (both read the same table under their own role).
export function fromPaymentRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    sourceWalletId: row.source_wallet_id,
    counterpartyId: row.counterparty_id,
    asset: row.asset,
    amount: moneyNumber(row.amount),
    fee: moneyNumber(row.fee),
    status: row.status,
    approvals: row.approvals,
    requiredApprovals: row.required_approvals,
    screenResult: row.screen_result,
    createdAt: iso(row.created_at),
    settledAt: isoOrEmpty(row.settled_at),
    providerRef: row.provider_ref,
    chainRef: row.chain_ref,
    memo: row.memo,
    createdBy: row.created_by || null
  };
}

export function withTenant(events, tenantId) {
  return events.map((event) => ({ ...event, tenantId }));
}
