import { createSeedData, roundMoney } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

const port = Number(process.env.PORT || 4101);
const store = createDurableStore("wallet-service", () => {
  const seed = createSeedData();
  return {
    assets: seed.assets,
    entities: seed.entities,
    debitOperations: {},
    wallets: seed.wallets
  };
});
store.state.debitOperations ||= {};
store.save();

createJsonService({
  name: "wallet-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "wallet-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/entities", () => ok(store.state.entities)),
    route("GET", "/entities/:id", ({ params }) => ok(find(store.state.entities, params.id, "entity"))),
    route("GET", "/assets", () => ok(store.state.assets)),
    route("GET", "/assets/:id", ({ params }) => ok(find(store.state.assets, params.id, "asset"))),
    route("GET", "/wallets", () => ok(store.state.wallets)),
    route("GET", "/wallets/:id", ({ params }) => ok(find(store.state.wallets, params.id, "wallet"))),
    route("POST", "/wallets/:id/debit", ({ params, body, headers }) => {
      const wallet = find(store.state.wallets, params.id, "wallet");
      const idempotencyKey = headers["idempotency-key"] || body.idempotencyKey;
      if (!idempotencyKey) {
        throw httpError(428, "Idempotency-Key is required for wallet debits", "idempotency_required");
      }
      if (store.state.debitOperations[idempotencyKey]) {
        return ok(store.state.debitOperations[idempotencyKey]);
      }
      const amount = Number(body.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw httpError(422, "Debit amount must be positive", "invalid_amount");
      }
      if (wallet.status !== "Active") {
        throw httpError(409, `Wallet ${wallet.id} is not active`, "wallet_inactive");
      }
      if (wallet.balance < amount) {
        throw httpError(409, "Insufficient wallet balance", "insufficient_balance");
      }
      wallet.balance = roundMoney(wallet.balance - amount);
      store.state.debitOperations[idempotencyKey] = {
        idempotencyKey,
        walletId: wallet.id,
        amount,
        balance: wallet.balance,
        at: new Date().toISOString()
      };
      store.save();
      return ok(store.state.debitOperations[idempotencyKey]);
    })
  ]
});

function find(collection, id, label) {
  const item = collection.find((entry) => entry.id === id);
  if (!item) {
    throw httpError(404, `${label} ${id} not found`, "not_found");
  }
  return item;
}
