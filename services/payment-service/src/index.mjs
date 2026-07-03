import { createId, estimateFee, randomHex } from "../../../packages/shared/data.mjs";
import { query, withTransaction } from "../../../packages/shared/db.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { serviceGet, servicePost } from "../../../packages/shared/service-client.mjs";
import { DEFAULT_TENANT_ID } from "../../../packages/shared/tenant.mjs";
import { requiredApprovalsFor } from "./approvals.mjs";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "./idempotency.mjs";
import { reseedPayments } from "./seed.mjs";

const port = Number(process.env.PORT || 4104);
const DB = "payment";

await bootstrap();

createJsonService({
  name: "payment-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "payment-service" })),
    route("GET", "/ready", async () => {
      await query(DB, "SELECT 1");
      return ok({ status: "ready" });
    }),
    route("POST", "/reset", async () => {
      await reseedPayments();
      return ok(await listPayments());
    }),
    route("GET", "/payments", async () => ok(await listPayments())),
    route("GET", "/payments/:id", async ({ params }) => ok(await findPayment(params.id))),
    route("POST", "/payments", async ({ body, headers }) => ok({ payment: await createPayment(body, headers["idempotency-key"]) })),
    route("POST", "/payments/:id/approve", async ({ params }) => ok({ payment: await approvePayment(params.id) })),
    route("POST", "/payments/:id/execute", async ({ params }) => ok({ payment: await executePayment(params.id) })),
    route("POST", "/payments/:id/cancel", async ({ params }) => ok({ payment: await cancelPayment(params.id) }))
  ]
});

async function createPayment(input, idempotencyKey) {
  let requestHash = null;
  if (idempotencyKey) {
    requestHash = hashRequest(input);
    const reservation = await reserveIdempotencyKey("create", idempotencyKey, requestHash);
    if (reservation.outcome === "hash_mismatch") {
      throw httpError(422, "Idempotency-Key was already used with a different request body", "idempotency_key_reuse");
    }
    if (reservation.outcome === "done") {
      return findPayment(reservation.paymentId);
    }
    // outcome === "reserved": this call owns the key and must complete or release it. Unlike the
    // JS in-process lock this replaced, there is no "in_progress" outcome to handle here --
    // reserveIdempotencyKey's INSERT blocked on any concurrent racer until it resolved.
  }

  try {
    const wallet = await serviceGet("wallet", `/wallets/${input.sourceWalletId}`);
    const counterparty = await serviceGet("compliance", `/counterparties/${input.counterpartyId}`);
    const policy = await serviceGet("policy", "/policies");
    const amount = Number(input.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw httpError(422, "Payment amount must be positive", "invalid_amount");
    }

    const payment = {
      id: createId("pay"),
      reference: await allocateReference(),
      type: input.type || "Supplier",
      sourceWalletId: wallet.id,
      counterpartyId: counterparty.id,
      asset: wallet.asset,
      amount,
      fee: estimateFee(amount, wallet.asset),
      status: "Pending approval",
      approvals: 0,
      requiredApprovals: requiredApprovalsFor(amount, wallet.asset, policy),
      screenResult: counterparty.status === "Approved" ? "Clear" : counterparty.status,
      createdAt: new Date().toISOString(),
      settledAt: "",
      providerRef: "",
      chainRef: "",
      memo: String(input.memo || "").trim()
    };

    const evaluation = await evaluatePayment(payment);
    let autoApproved = false;
    if (evaluation.decision.status === "Blocked") {
      payment.status = "Blocked";
    } else if (evaluation.decision.status === "Clear" && payment.requiredApprovals === 0) {
      payment.status = "Approved";
      autoApproved = true;
    }

    await insertPayment(payment);
    if (idempotencyKey) {
      await completeIdempotencyKey("create", idempotencyKey, payment.id);
    }

    if (evaluation.decision.status === "Blocked") {
      await bestEffortPost("reconciliation", "/reconciliation/exceptions", {
        payment,
        issue: evaluation.decision.detail,
        source: "Policy engine"
      });
      await bestEffortPost("operations", "/alerts", {
        severity: "High",
        title: `${payment.reference} blocked`,
        detail: evaluation.decision.detail
      });
      await audit("Policy engine", "Payment blocked", payment.reference, evaluation.decision.detail);
    } else if (autoApproved) {
      await audit(
        "Policy engine",
        "Payment auto-approved",
        payment.reference,
        `${payment.asset} ${payment.amount} to ${counterparty.name} auto-approved (below approval threshold)`
      );
    } else {
      await audit("Marta Klein", "Payment created", payment.reference, `${payment.asset} ${payment.amount} to ${counterparty.name}`);
    }

    return payment;
  } catch (error) {
    if (idempotencyKey) {
      await releaseIdempotencyKey("create", idempotencyKey);
    }
    throw error;
  }
}

async function approvePayment(id) {
  const payment = await findPayment(id);
  if (["Approved", "Executing", "Settled"].includes(payment.status)) {
    return payment;
  }
  if (payment.status !== "Pending approval") {
    throw httpError(409, `Payment ${payment.reference} is not pending approval`, "invalid_state");
  }

  const evaluation = await evaluatePayment(payment);
  if (evaluation.decision.status === "Blocked") {
    const blocked = await transitionIfStatus(id, "Pending approval", { status: "Blocked" });
    await audit("Policy engine", "Payment blocked", payment.reference, evaluation.decision.detail);
    return blocked || (await findPayment(id));
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before approval`, "review_required");
  }

  // The evaluate() call above is a read-only network round trip and does not need to hold a row
  // lock. The actual approvals++ / status transition below is the critical section that raced
  // under concurrent calls before this port (see the M0 lock.mjs comment this replaces): it runs
  // inside a single short transaction that re-reads the row FOR UPDATE, so two concurrent
  // approvals on the same payment serialize here instead of both incrementing from a stale read.
  const updated = await withTransaction(DB, async (client) => {
    const { rows } = await client.query("SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, DEFAULT_TENANT_ID]);
    const current = fromRow(rows[0]);
    if (current.status !== "Pending approval") {
      // Another concurrent call already moved this payment past Pending approval while we were
      // evaluating; nothing left for this call to do.
      return current;
    }
    const approvals = current.approvals + 1;
    const nextStatus = approvals >= current.requiredApprovals ? "Approved" : "Pending approval";
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET approvals = $1, status = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *",
      [approvals, nextStatus, id, DEFAULT_TENANT_ID]
    );
    return fromRow(updatedRows[0]);
  });
  await audit("Marta Klein", "Payment approved", updated.reference, `${updated.approvals}/${updated.requiredApprovals} approvals`);
  return updated;
}

async function executePayment(id) {
  const payment = await findPayment(id);
  if (payment.status === "Settled") {
    return payment;
  }
  if (!["Approved", "Executing"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} is not approved`, "invalid_state");
  }

  const context = await getPaymentContext(payment);
  if (payment.status === "Approved") {
    const evaluation = await servicePost("policy", "/evaluate", { payment, ...context });
    if (evaluation.decision.status === "Blocked") {
      const blocked = await transitionIfStatus(id, "Approved", { status: "Blocked" });
      await audit("Policy engine", "Execution blocked", payment.reference, evaluation.decision.detail);
      return blocked || (await findPayment(id));
    }
    if (evaluation.decision.status === "Review") {
      throw httpError(409, `Payment ${payment.reference} requires review before execution`, "review_required");
    }

    // Written and committed before the wallet debit call below so a crash mid-debit leaves the
    // payment visibly "Executing" rather than silently stuck at "Approved" -- this is what makes
    // a retried execute() call resumable instead of a second, conflicting attempt.
    await transitionIfStatus(id, "Approved", { status: "Executing" });
  }

  // Resolve whether the counterparty's wallet address matches a wallet this tenant already owns
  // (an intra-group transfer) so wallet-service can credit that wallet's own ledger account
  // instead of the external settlement_clearing account -- without this, intra-group payments
  // debited the source wallet with nowhere for the money to land.
  const destinationWallet = context.wallets.find(
    (candidate) => candidate.id !== payment.sourceWalletId && candidate.address === context.counterparty.wallet && candidate.asset === payment.asset
  );

  let debited;
  try {
    debited = await servicePost(
      "wallet",
      `/wallets/${payment.sourceWalletId}/debit`,
      {
        principal: payment.amount,
        fee: payment.fee,
        destinationWalletId: destinationWallet?.id,
        paymentId: payment.id
      },
      { idempotencyKey: `debit:${payment.id}` }
    );
  } catch (error) {
    if (error.status === 409) {
      await transitionIfStatus(id, "Executing", { status: "Failed" });
    }
    throw error;
  }

  const providerRef = payment.providerRef || `ARC-${randomHex(5)}`;
  const chainRef = payment.chainRef || `0x${randomHex(14).toLowerCase()}`;
  await query(DB, "UPDATE payment.payments SET provider_ref = $1, chain_ref = $2 WHERE id = $3 AND tenant_id = $4", [
    providerRef,
    chainRef,
    id,
    DEFAULT_TENANT_ID
  ]);
  const settlingPayment = { ...payment, providerRef, chainRef, status: "Executing" };

  await servicePost("accounting", "/journals/from-payment", { payment: settlingPayment, ...context });
  await servicePost("reconciliation", "/reconciliation/matched", { payment: settlingPayment });

  const settledAt = payment.settledAt || new Date().toISOString();
  await query(DB, "UPDATE payment.payments SET status = 'Settled', settled_at = $1 WHERE id = $2 AND tenant_id = $3", [
    settledAt,
    id,
    DEFAULT_TENANT_ID
  ]);
  await audit("Arcadia Custody Bank", "Payment settled", payment.reference, `Provider reference ${providerRef}`);
  return findPayment(id);
}

async function cancelPayment(id) {
  const payment = await findPayment(id);
  if (payment.status === "Cancelled") {
    return payment;
  }
  if (!["Pending approval", "Approved"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} cannot be cancelled`, "invalid_state");
  }
  const updated = await withTransaction(DB, async (client) => {
    const { rows } = await client.query("SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [id, DEFAULT_TENANT_ID]);
    const current = fromRow(rows[0]);
    if (!["Pending approval", "Approved"].includes(current.status)) {
      return current;
    }
    const { rows: updatedRows } = await client.query(
      "UPDATE payment.payments SET status = 'Cancelled' WHERE id = $1 AND tenant_id = $2 RETURNING *",
      [id, DEFAULT_TENANT_ID]
    );
    return fromRow(updatedRows[0]);
  });
  await audit("Marta Klein", "Payment cancelled", updated.reference, "User cancelled payment before execution");
  return updated;
}

async function evaluatePayment(payment) {
  const context = await getPaymentContext(payment);
  return servicePost("policy", "/evaluate", { payment, ...context });
}

async function getPaymentContext(payment) {
  const wallet = await serviceGet("wallet", `/wallets/${payment.sourceWalletId}`);
  const entity = await serviceGet("wallet", `/entities/${wallet.entityId}`);
  const asset = await serviceGet("wallet", `/assets/${payment.asset}`);
  const counterparty = await serviceGet("compliance", `/counterparties/${payment.counterpartyId}`);
  const provider = await serviceGet("operations", `/providers/${wallet.providerId}`);
  const wallets = await serviceGet("wallet", "/wallets");
  return { wallet, wallets, entity, asset, counterparty, provider };
}

async function audit(actor, action, object, detail) {
  return bestEffortPost("operations", "/audit", { actor, action, object, detail });
}

async function bestEffortPost(service, path, body) {
  try {
    return await servicePost(service, path, body);
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "side_effect_failed",
      service,
      path,
      message: error.message
    }));
    return null;
  }
}

// Guarded transition: only writes if the row is still in fromStatus at the moment the lock is
// acquired, so a caller that read a stale status before an await can't clobber a state another
// concurrent call already moved past. Returns null (not the row) when the guard didn't match, so
// callers can distinguish "I made this transition" from "someone already did."
async function transitionIfStatus(id, fromStatus, patch) {
  return withTransaction(DB, async (client) => {
    const { rows } = await client.query("SELECT status FROM payment.payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [
      id,
      DEFAULT_TENANT_ID
    ]);
    if (!rows[0] || rows[0].status !== fromStatus) {
      return null;
    }
    const sets = [];
    const values = [];
    let i = 1;
    for (const [column, value] of Object.entries(patch)) {
      sets.push(`${toColumn(column)} = $${i}`);
      values.push(value);
      i += 1;
    }
    values.push(id, DEFAULT_TENANT_ID);
    const { rows: updatedRows } = await client.query(
      `UPDATE payment.payments SET ${sets.join(", ")} WHERE id = $${i} AND tenant_id = $${i + 1} RETURNING *`,
      values
    );
    return fromRow(updatedRows[0]);
  });
}

function toColumn(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

async function insertPayment(payment) {
  await query(
    DB,
    `INSERT INTO payment.payments
       (id, tenant_id, reference, type, source_wallet_id, counterparty_id, asset, amount, fee, status, approvals, required_approvals, screen_result, provider_ref, chain_ref, memo, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      payment.id,
      DEFAULT_TENANT_ID,
      payment.reference,
      payment.type,
      payment.sourceWalletId,
      payment.counterpartyId,
      payment.asset,
      payment.amount,
      payment.fee,
      payment.status,
      payment.approvals,
      payment.requiredApprovals,
      payment.screenResult,
      payment.providerRef,
      payment.chainRef,
      payment.memo,
      payment.createdAt
    ]
  );
}

function fromRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    sourceWalletId: row.source_wallet_id,
    counterpartyId: row.counterparty_id,
    asset: row.asset,
    amount: Number(row.amount),
    fee: Number(row.fee),
    status: row.status,
    approvals: row.approvals,
    requiredApprovals: row.required_approvals,
    screenResult: row.screen_result,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    settledAt: row.settled_at ? (row.settled_at instanceof Date ? row.settled_at.toISOString() : row.settled_at) : "",
    providerRef: row.provider_ref,
    chainRef: row.chain_ref,
    memo: row.memo
  };
}

async function listPayments() {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE tenant_id = $1 ORDER BY created_at DESC", [DEFAULT_TENANT_ID]);
  return rows.map(fromRow);
}

async function findPayment(id) {
  const { rows } = await query(DB, "SELECT * FROM payment.payments WHERE id = $1 AND tenant_id = $2", [id, DEFAULT_TENANT_ID]);
  if (!rows[0]) {
    throw httpError(404, `payment ${id} not found`, "not_found");
  }
  return fromRow(rows[0]);
}

async function bootstrap() {
  const { rows } = await query(DB, "SELECT COUNT(*)::int AS count FROM payment.payments WHERE tenant_id = $1", [DEFAULT_TENANT_ID]);
  if (rows[0].count === 0) {
    await reseedPayments();
  }
}
