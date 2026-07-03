import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { reseedWallets } from "./seed.mjs";

const port = Number(process.env.PORT || 4101);
const DB = "wallet";

await bootstrap();

createJsonService({
  name: "wallet-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "wallet-service" })),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }),
    route("POST", "/reset", async () => {
      await reseedWallets();
      return ok(await listWallets());
    }),
    route("GET", "/entities", async () => ok(await listEntities())),
    route("GET", "/entities/:id", async ({ params }) => ok(await findEntity(params.id))),
    route("GET", "/assets", async () => ok(await listAssets())),
    route("GET", "/assets/:id", async ({ params }) => ok(await findAsset(params.id))),
    route("GET", "/wallets", async () => ok(await listWallets())),
    route("GET", "/wallets/:id", async ({ params }) => ok(await findWallet(params.id))),
    route("POST", "/wallets/:id/debit", async ({ params, body, headers }) => {
      const idempotencyKey = headers["idempotency-key"] || body.idempotencyKey;
      if (!idempotencyKey) {
        throw httpError(428, "Idempotency-Key is required for wallet debits", "idempotency_required");
      }
      const amount = Number(body.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw httpError(422, "Debit amount must be positive", "invalid_amount");
      }

      return withTransaction(DB, async (client) => {
        // INSERT ... ON CONFLICT DO NOTHING against the idempotency_key PRIMARY KEY is the
        // reservation. Under READ COMMITTED (Postgres's default), a second transaction racing
        // on the same key blocks on this INSERT until the first commits or rolls back, then
        // correctly resolves as a real conflict (first committed -> return its result) or a
        // fresh insert (first rolled back -> proceed as the new owner). This is what made the
        // JS-level idempotency reservation in payment-service (M0) necessary there; here the
        // database provides the same guarantee natively.
        const reserved = await client.query(
          `INSERT INTO wallet.debit_operations (idempotency_key, tenant_id, wallet_id, amount, balance_after)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *`,
          [idempotencyKey, DEFAULT_TENANT_ID, params.id, amount]
        );

        if (reserved.rows.length === 0) {
          const { rows } = await client.query("SELECT * FROM wallet.debit_operations WHERE idempotency_key = $1", [idempotencyKey]);
          return ok(toDebitShape(rows[0]));
        }

        const walletRows = await client.query("SELECT * FROM wallet.wallets WHERE id = $1 AND tenant_id = $2", [params.id, DEFAULT_TENANT_ID]);
        if (!walletRows.rows[0]) {
          throw httpError(404, `wallet ${params.id} not found`, "not_found");
        }
        if (walletRows.rows[0].status !== "Active") {
          throw httpError(409, `Wallet ${params.id} is not active`, "wallet_inactive");
        }

        // The WHERE clause makes the check-and-debit a single atomic statement: the balance
        // CHECK constraint (0002_wallet.sql) is a second line of defense, but this WHERE clause
        // is what actually prevents a debit from being applied at all when funds are insufficient
        // -- Postgres serializes concurrent UPDATEs to the same row, so no interleaving of two
        // concurrent debits can overdraft this wallet.
        const updated = await client.query(
          "UPDATE wallet.wallets SET balance = balance - $1, updated_at = now() WHERE id = $2 AND balance >= $1 RETURNING *",
          [amount, params.id]
        );
        if (!updated.rows[0]) {
          throw httpError(409, "Insufficient wallet balance", "insufficient_balance");
        }

        await client.query("UPDATE wallet.debit_operations SET balance_after = $1 WHERE idempotency_key = $2", [
          updated.rows[0].balance,
          idempotencyKey
        ]);

        return ok({
          idempotencyKey,
          walletId: params.id,
          amount,
          balance: Number(updated.rows[0].balance),
          at: new Date().toISOString()
        });
      });
    })
  ]
});

function toDebitShape(row) {
  return {
    idempotencyKey: row.idempotency_key,
    walletId: row.wallet_id,
    amount: Number(row.amount),
    balance: Number(row.balance_after),
    at: row.created_at.toISOString()
  };
}

function toEntityShape(row) {
  return { id: row.id, name: row.name, jurisdiction: row.jurisdiction, baseCurrency: row.base_currency, erpCode: row.erp_code };
}

function toAssetShape(row) {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    issuer: row.issuer,
    chain: row.chain,
    classification: row.classification,
    status: row.status,
    risk: row.risk,
    providerId: row.provider_id
  };
}

function toWalletShape(row) {
  return {
    id: row.id,
    entityId: row.entity_id,
    providerId: row.provider_id,
    asset: row.asset_id,
    address: row.address,
    custody: row.custody,
    status: row.status,
    balance: Number(row.balance)
  };
}

async function listEntities() {
  const { rows } = await query(DB, "SELECT * FROM wallet.legal_entities WHERE tenant_id = $1 ORDER BY id", [DEFAULT_TENANT_ID]);
  return rows.map(toEntityShape);
}

async function findEntity(id) {
  const { rows } = await query(DB, "SELECT * FROM wallet.legal_entities WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
  if (!rows[0]) throw httpError(404, `entity ${id} not found`, "not_found");
  return toEntityShape(rows[0]);
}

async function listAssets() {
  const { rows } = await query(DB, "SELECT * FROM wallet.assets WHERE tenant_id = $1 ORDER BY id", [DEFAULT_TENANT_ID]);
  return rows.map(toAssetShape);
}

async function findAsset(id) {
  const { rows } = await query(DB, "SELECT * FROM wallet.assets WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
  if (!rows[0]) throw httpError(404, `asset ${id} not found`, "not_found");
  return toAssetShape(rows[0]);
}

async function listWallets() {
  const { rows } = await query(DB, "SELECT * FROM wallet.wallets WHERE tenant_id = $1 ORDER BY id", [DEFAULT_TENANT_ID]);
  return rows.map(toWalletShape);
}

async function findWallet(id) {
  const { rows } = await query(DB, "SELECT * FROM wallet.wallets WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
  if (!rows[0]) throw httpError(404, `wallet ${id} not found`, "not_found");
  return toWalletShape(rows[0]);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM wallet.wallets WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedWallets();
  }
}
