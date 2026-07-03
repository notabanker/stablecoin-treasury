import { createId, createSeedData } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

const port = Number(process.env.PORT || 4106);
const store = createDurableStore("reconciliation-service", () => ({ reconciliation: createSeedData().reconciliation }));

createJsonService({
  name: "reconciliation-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "reconciliation-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/reconciliation", () => ok(store.state.reconciliation.map(withComputedAge))),
    route("POST", "/reconciliation/matched", ({ body }) => {
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const existing = store.state.reconciliation.find((entry) => entry.paymentId === payment.id && entry.issue === "Matched");
      if (existing) {
        return ok(withComputedAge(existing));
      }
      const item = {
        id: createId("rec"),
        paymentId: payment.id,
        source: body.source || "On-chain event",
        issue: "Matched",
        amount: payment.amount,
        asset: payment.asset,
        status: "Resolved",
        owner: "Auto",
        createdAt: new Date().toISOString()
      };
      store.state.reconciliation.unshift(item);
      store.save();
      return ok(withComputedAge(item));
    }),
    route("POST", "/reconciliation/exceptions", ({ body }) => {
      if (!body.payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const payment = body.payment;
      const item = {
        id: createId("rec"),
        paymentId: payment.id,
        source: body.source || "Policy engine",
        issue: body.issue || "Manual exception",
        amount: Number(body.amount ?? payment.amount),
        asset: body.asset || payment.asset,
        status: "Open",
        owner: body.owner || "Treasury Ops",
        createdAt: new Date().toISOString()
      };
      store.state.reconciliation.unshift(item);
      store.save();
      return ok(withComputedAge(item));
    }),
    route("POST", "/reconciliation/exceptions/simulate", ({ body }) => {
      const payment = body.payment;
      if (!payment) {
        throw httpError(422, "Payment is required", "missing_payment");
      }
      const item = {
        id: createId("rec"),
        paymentId: payment.id,
        source: "Ledger snapshot",
        issue: "Fee amount differs from provider callback",
        amount: payment.fee || 0,
        asset: payment.asset,
        status: "Open",
        owner: "Treasury Ops",
        createdAt: new Date().toISOString()
      };
      store.state.reconciliation.unshift(item);
      store.save();
      return ok(withComputedAge(item));
    }),
    route("POST", "/reconciliation/:id/resolve", ({ params, body }) => {
      const item = store.state.reconciliation.find((entry) => entry.id === params.id);
      if (!item) {
        throw httpError(404, `reconciliation ${params.id} not found`, "not_found");
      }
      item.status = "Resolved";
      item.owner = body?.owner || "Treasury Ops";
      item.resolvedAt = new Date().toISOString();
      store.save();
      return ok(withComputedAge(item));
    })
  ]
});

function withComputedAge(item) {
  const createdAt = item.createdAt || new Date().toISOString();
  const endedAt = item.resolvedAt ? new Date(item.resolvedAt) : new Date();
  const ageHours = Math.max(0, (endedAt.getTime() - new Date(createdAt).getTime()) / 3_600_000);
  return { ...item, createdAt, ageHours: Math.round(ageHours * 10) / 10 };
}
