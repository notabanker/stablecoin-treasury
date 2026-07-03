import { createSeedData } from "../../../packages/shared/data.mjs";
import { createJsonService, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";
import { evaluate, numberOr, validatePolicy } from "./evaluate.mjs";

const port = Number(process.env.PORT || 4102);
const store = createDurableStore("policy-service", () => ({ policies: createSeedData().policies }));

createJsonService({
  name: "policy-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "policy-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/policies", () => ok(store.state.policies)),
    route("POST", "/policies", ({ body }) => {
      const current = store.state.policies;
      const next = {
        ...current,
        approvalThreshold: numberOr(current.approvalThreshold, body.approvalThreshold),
        secondApprovalThreshold: numberOr(current.secondApprovalThreshold, body.secondApprovalThreshold),
        hardTransferLimit: numberOr(current.hardTransferLimit, body.hardTransferLimit),
        concentrationLimit: numberOr(current.concentrationLimit, body.concentrationLimit)
      };
      validatePolicy(next);
      store.state.policies = next;
      store.save();
      return ok(store.state.policies);
    }),
    route("POST", "/policies/assets/:assetId", ({ params, body }) => {
      const allowed = new Set(store.state.policies.allowedAssets);
      if (body.enabled) {
        allowed.add(params.assetId);
      } else {
        allowed.delete(params.assetId);
      }
      store.state.policies.allowedAssets = [...allowed];
      store.save();
      return ok(store.state.policies);
    }),
    route("POST", "/evaluate", ({ body }) => ok(evaluate(body, store.state.policies)))
  ]
});
