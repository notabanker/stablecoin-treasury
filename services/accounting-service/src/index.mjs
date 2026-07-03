import { createId, createSeedData, roundMoney } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

const port = Number(process.env.PORT || 4105);
const store = createDurableStore("accounting-service", () => ({ journalEntries: createSeedData().journalEntries }));

createJsonService({
  name: "accounting-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "accounting-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/journals", () => ok(store.state.journalEntries)),
    route("POST", "/journals/from-payment", ({ body }) => {
      if (!body.payment || !body.entity || !body.asset) {
        throw httpError(422, "Payment, entity, and asset are required", "missing_context");
      }
      const existing = store.state.journalEntries.filter((entry) => entry.paymentId === body.payment.id);
      if (existing.length) {
        return ok(existing);
      }
      const entries = createPaymentJournals(body.payment, body.wallet, body.entity, body.asset);
      assertBalanced(entries);
      store.state.journalEntries.unshift(...entries);
      store.save();
      return ok(entries);
    }),
    route("POST", "/journals/export", () => {
      store.state.journalEntries.forEach((entry) => {
        if (entry.status === "Ready") {
          entry.status = "Exported";
        }
      });
      store.save();
      return ok(store.state.journalEntries);
    })
  ]
});

function createPaymentJournals(payment, wallet, entity, asset) {
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

function assertBalanced(entries) {
  const debit = roundMoney(entries.reduce((sum, entry) => sum + Number(entry.debit || 0), 0));
  const credit = roundMoney(entries.reduce((sum, entry) => sum + Number(entry.credit || 0), 0));
  if (debit !== credit) {
    throw httpError(500, `Journal batch is unbalanced: debit ${debit}, credit ${credit}`, "unbalanced_journal");
  }
}
