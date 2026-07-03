import { createSeedData } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";
import { assertBalanced, createPaymentJournals } from "./journals.mjs";

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
