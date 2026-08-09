import { createId } from "../../../packages/shared/data.mjs";
import { httpError } from "../../../packages/shared/http.mjs";
import { Money, moneyNumber, parseMoneyInput } from "../../../packages/shared/money.mjs";

export function createPaymentJournals(payment, wallet, entity, asset) {
  const date = new Date().toISOString().slice(0, 10);
  const currency = asset?.currency || (payment.asset === "USDC" ? "USD" : "EUR");
  let amountMoney;
  let feeMoney;
  try {
    amountMoney = parseMoneyInput(payment.amount);
    feeMoney = parseMoneyInput(payment.fee || 0);
  } catch {
    throw httpError(422, "Payment amount and fee must be valid numbers", "invalid_amount");
  }
  if (!amountMoney.isPositive() || feeMoney.isNegative()) {
    throw httpError(422, "Payment amount and fee must be valid numbers", "invalid_amount");
  }
  const amount = amountMoney.toNumber();
  const fee = feeMoney.toNumber();
  const cashOut = amountMoney.plus(feeMoney).toNumber();
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
  const debit = entries.reduce((sum, entry) => sum.plus(Money.fromNumber(moneyNumber(entry.debit || 0))), Money.zero()).toNumber();
  const credit = entries.reduce((sum, entry) => sum.plus(Money.fromNumber(moneyNumber(entry.credit || 0))), Money.zero()).toNumber();
  if (debit !== credit) {
    throw httpError(500, `Journal batch is unbalanced: debit ${debit}, credit ${credit}`, "unbalanced_journal");
  }
}
