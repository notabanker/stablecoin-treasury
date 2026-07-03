import { createSeedData } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

const port = Number(process.env.PORT || 4103);
const store = createDurableStore("compliance-service", () => ({ counterparties: createSeedData().counterparties }));

createJsonService({
  name: "compliance-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "compliance-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/counterparties", () => ok(store.state.counterparties)),
    route("GET", "/counterparties/:id", ({ params }) => ok(findCounterparty(params.id))),
    route("POST", "/screen", ({ body }) => {
      const counterparty = findCounterparty(body.counterpartyId);
      return ok({
        counterpartyId: counterparty.id,
        provider: "Sentinel Chain Analytics",
        result: counterparty.status === "Approved" ? "Clear" : counterparty.status,
        risk: counterparty.risk,
        reason: counterparty.status === "Blocked" ? "Counterparty is blocked by screening policy" : "Seeded screening result"
      });
    })
  ]
});

function findCounterparty(id) {
  const item = store.state.counterparties.find((entry) => entry.id === id);
  if (!item) {
    throw httpError(404, `counterparty ${id} not found`, "not_found");
  }
  return item;
}
