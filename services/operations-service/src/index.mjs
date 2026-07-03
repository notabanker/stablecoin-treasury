import { createId, createSeedData } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

const port = Number(process.env.PORT || 4107);
const store = createDurableStore("operations-service", () => {
  const seed = createSeedData();
  return {
    alerts: seed.alerts,
    audit: seed.audit,
    providers: seed.providers
  };
});

createJsonService({
  name: "operations-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "operations-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/providers", () => ok(store.state.providers)),
    route("GET", "/providers/:id", ({ params }) => ok(find(store.state.providers, params.id, "provider"))),
    route("POST", "/providers/:id/toggle", ({ params }) => {
      const provider = find(store.state.providers, params.id, "provider");
      if (provider.status === "Operational") {
        provider.status = "Degraded";
        provider.incident = "Manual route degradation";
      } else {
        provider.status = "Operational";
        provider.incident = "";
      }
      appendAudit("Marta Klein", "Provider status changed", provider.name, provider.status);
      return ok(provider);
    }),
    route("GET", "/audit", () => ok(store.state.audit)),
    route("POST", "/audit", ({ body }) => {
      const event = appendAudit(body.actor || "System", body.action, body.object, body.detail);
      return ok(event);
    }),
    route("GET", "/alerts", () => ok(store.state.alerts)),
    route("POST", "/alerts", ({ body }) => {
      const alert = {
        id: createId("alt"),
        severity: body.severity || "Medium",
        title: body.title,
        detail: body.detail || "",
        status: body.status || "Open"
      };
      store.state.alerts.unshift(alert);
      store.save();
      return ok(alert);
    }),
    route("POST", "/incidents/simulate", () => {
      const provider = store.state.providers.find((item) => item.status === "Operational");
      if (!provider) {
        throw httpError(409, "No operational provider available to degrade", "no_provider");
      }
      provider.status = "Degraded";
      provider.incident = "Synthetic latency incident";
      const alert = {
        id: createId("alt"),
        severity: "Medium",
        title: `${provider.name} degraded`,
        detail: "Synthetic latency incident recorded.",
        status: "Open"
      };
      store.state.alerts.unshift(alert);
      appendAudit("System monitor", "Provider incident opened", provider.name, provider.incident);
      return ok({ provider, alert });
    })
  ]
});

function appendAudit(actor, action, object, detail) {
  const event = {
    id: createId("aud"),
    at: new Date().toISOString(),
    actor,
    action,
    object,
    detail
  };
  store.state.audit.unshift(event);
  store.save();
  return event;
}

function find(collection, id, label) {
  const item = collection.find((entry) => entry.id === id);
  if (!item) {
    throw httpError(404, `${label} ${id} not found`, "not_found");
  }
  return item;
}
