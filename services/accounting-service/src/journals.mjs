import { createId, roundMoney } from "../../../packages/shared/data.mjs";
import { httpError } from "../../../packages/shared/http.mjs";

export function createPaymentJournals(payment, wallet, entity, asset) {
  const date = new Date().toISOString().slice(0, 10);
  const currency = asset?.currency || (payment.asset === "USDC" ? "USD" : "EUR");
  const amount = Number(payment.amount);
  const fee = Number(payment.fee || 0);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(fee) || fee < 0) {
    throw httpError(422, "Payment amount and fee must be valid numbers", "invalid_amount");
  }
  const cashOut = roundMoney(amount + fee);
  return [
    {
      id: createId("je"),
      date,
      entityId: entity.id,
      paymentId: payment.id,
      account: "Stablecoin cash equivalent",
      debit: 0,
      credit: cashOut,
      currency,
      status: "Ready"
    },
    {
      id: createId("je"),
      date,
      entityId: entity.id,
      paymentId: payment.id,
      account: payment.type === "Intra-group" ? "Intercompany receivable" : "Supplier payable",
      debit: amount,
      credit: 0,
      currency,
      status: "Ready"
    },
    {
      id: createId("je"),
      date,
      entityId: entity.id,
      paymentId: payment.id,
      account: "Network and provider fees",
      debit: fee,
      credit: 0,
      currency,
      status: "Ready"
    }
  ];
}

export function assertBalanced(entries) {
  const debit = roundMoney(entries.reduce((sum, entry) => sum + Number(entry.debit || 0), 0));
  const credit = roundMoney(entries.reduce((sum, entry) => sum + Number(entry.credit || 0), 0));
  if (debit !== credit) {
    throw httpError(500, `Journal batch is unbalanced: debit ${debit}, credit ${credit}`, "unbalanced_journal");
  }
}
