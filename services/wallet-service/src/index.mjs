import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { getOrCreateSharedAccount, getOrCreateWalletAccount, getWalletBalance, postTransaction } from "./ledger.mjs";
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
    // The debit request splits principal and fee so the ledger can route each correctly: the
    // fee always leaves to the shared fees account (a real cost either way), while the principal
    // goes to the destination wallet's own ledger account when the counterparty resolves to
    // another wallet this tenant owns (an intra-group transfer), or to the shared
    // settlement_clearing account when it's leaving custody to an external party. Before this
    // ledger existed, intra-group payments only ever debited the source wallet -- the money had
    // nowhere to land and simply vanished from the books.
    route("POST", "/wallets/:id/debit", async ({ params, body, headers }) => {
      const idempotencyKey = headers["idempotency-key"] || body.idempotencyKey;
      if (!idempotencyKey) {
        throw httpError(428, "Idempotency-Key is required for wallet debits", "idempotency_required");
      }
      const principal = Number(body.principal ?? body.amount ?? 0);
      const fee = Number(body.fee ?? 0);
      if (!Number.isFinite(principal) || principal <= 0) {
        throw httpError(422, "Debit principal must be positive", "invalid_amount");
      }
      if (!Number.isFinite(fee) || fee < 0) {
        throw httpError(422, "Debit fee must be a non-negative number", "invalid_amount");
      }
      const total = principal + fee;

      return withTransaction(DB, async (client) => {
        // Locking the wallet row is a proxy for locking "this wallet's balance": balance is now
        // derived from ledger entries rather than a column we could lock directly, so concurrent
        // debits against the same wallet serialize on this row lock instead.
        const walletRows = await client.query("SELECT * FROM wallet.wallets WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [
          params.id,
          DEFAULT_TENANT_ID
        ]);
        if (!walletRows.rows[0]) {
          throw httpError(404, `wallet ${params.id} not found`, "not_found");
        }
        const wallet = walletRows.rows[0];

        const existingTx = await client.query("SELECT * FROM wallet.ledger_transactions WHERE tenant_id = $1 AND idempotency_key = $2", [
          DEFAULT_TENANT_ID,
          idempotencyKey
        ]);
        if (existingTx.rows[0]) {
          const balance = await getWalletBalance(client, params.id);
          return ok({ idempotencyKey, walletId: params.id, amount: total, balance, at: existingTx.rows[0].created_at.toISOString() });
        }

        if (wallet.status !== "Active") {
          throw httpError(409, `Wallet ${params.id} is not active`, "wallet_inactive");
        }
        const currentBalance = await getWalletBalance(client, params.id);
        if (currentBalance < total) {
          throw httpError(409, "Insufficient wallet balance", "insufficient_balance");
        }

        const sourceAccount = await getOrCreateWalletAccount(client, wallet.id, wallet.asset_id);
        const entries = [{ accountId: sourceAccount.id, direction: "debit", amount: total }];

        let destinationWallet = null;
        if (body.destinationWalletId && body.destinationWalletId !== wallet.id) {
          const destRows = await client.query("SELECT * FROM wallet.wallets WHERE id = $1 AND tenant_id = $2 AND status = 'Active'", [
            body.destinationWalletId,
            DEFAULT_TENANT_ID
          ]);
          destinationWallet = destRows.rows[0] || null;
        }

        if (destinationWallet && destinationWallet.asset_id === wallet.asset_id) {
          const destAccount = await getOrCreateWalletAccount(client, destinationWallet.id, destinationWallet.asset_id);
          entries.push({ accountId: destAccount.id, direction: "credit", amount: principal });
        } else {
          const clearingAccount = await getOrCreateSharedAccount(client, "settlement_clearing", wallet.asset_id);
          entries.push({ accountId: clearingAccount.id, direction: "credit", amount: principal });
        }
        if (fee > 0) {
          const feesAccount = await getOrCreateSharedAccount(client, "fees", wallet.asset_id);
          entries.push({ accountId: feesAccount.id, direction: "credit", amount: fee });
        }

        await postTransaction(client, {
          idempotencyKey,
          description: destinationWallet ? `Transfer ${wallet.id} -> ${destinationWallet.id}` : `Debit ${wallet.id} to external party`,
          paymentId: body.paymentId || null,
          entries
        });

        const newBalance = await getWalletBalance(client, params.id);
        return ok({ idempotencyKey, walletId: params.id, amount: total, balance: newBalance, at: new Date().toISOString() });
      });
    })
  ]
});

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
  const { rows } = await query(
    DB,
    `SELECT w.*, wb.balance
     FROM wallet.wallets w
     LEFT JOIN wallet.wallet_balances wb ON wb.wallet_id = w.id
     WHERE w.tenant_id = $1
     ORDER BY w.id`,
    [DEFAULT_TENANT_ID]
  );
  return rows.map(toWalletShape);
}

async function findWallet(id) {
  const { rows } = await query(
    DB,
    `SELECT w.*, wb.balance
     FROM wallet.wallets w
     LEFT JOIN wallet.wallet_balances wb ON wb.wallet_id = w.id
     WHERE w.id = $1 AND w.tenant_id = $2`,
    [id, DEFAULT_TENANT_ID]
  );
  if (!rows[0]) throw httpError(404, `wallet ${id} not found`, "not_found");
  return toWalletShape(rows[0]);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM wallet.wallets WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedWallets();
  }
}
