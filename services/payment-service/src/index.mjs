import { createId, createSeedData, estimateFee, randomHex } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { serviceGet, servicePost } from "../../../packages/shared/service-client.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";
import { requiredApprovalsFor } from "./approvals.mjs";
import { allocateReference, completeIdempotencyKey, hashRequest, releaseIdempotencyKey, reserveIdempotencyKey } from "./idempotency.mjs";
import { withLock } from "./lock.mjs";

const port = Number(process.env.PORT || 4104);
const store = createDurableStore("payment-service", () => {
  const payments = createSeedData().payments;
  return {
    idempotency: {},
    payments,
    referenceCounter: highestReferenceIn(payments)
  };
});
store.state.idempotency ||= {};
if (!Number.isFinite(store.state.referenceCounter)) {
  store.state.referenceCounter = highestReferenceIn(store.state.payments);
}
store.save();

createJsonService({
  name: "payment-service",
  port,
  routes: [
    route("GET", "/health", () => ok({ status: "ok", service: "payment-service" })),
    route("GET", "/ready", () => ok({ status: "ready" })),
    route("POST", "/reset", () => ok(store.reset())),
    route("GET", "/payments", () => ok(store.state.payments)),
    route("GET", "/payments/:id", ({ params }) => ok(findPayment(params.id))),
    route("POST", "/payments", async ({ body, headers }) => ok({ payment: await createPayment(body, headers["idempotency-key"]) })),
    // approve/execute/cancel all read-then-write a payment's status and approvals count across
    // await boundaries (policy evaluation, downstream calls). withLock serializes calls per
    // payment id so concurrent requests against the same payment can't interleave their
    // check-then-write sections -- see lock.mjs.
    route("POST", "/payments/:id/approve", async ({ params }) => ok({ payment: await withLock(params.id, () => approvePayment(params.id)) })),
    route("POST", "/payments/:id/execute", async ({ params }) => ok({ payment: await withLock(params.id, () => executePayment(params.id)) })),
    route("POST", "/payments/:id/cancel", async ({ params }) => ok({ payment: await withLock(params.id, () => cancelPayment(params.id)) }))
  ]
});

async function createPayment(input, idempotencyKey) {
  // Everything up to and including allocateReference() below is synchronous -- no `await` --
  // so two concurrent requests can never interleave inside this block. That is what makes the
  // idempotency reservation and reference allocation race-free without a database transaction.
  let requestHash = null;
  if (idempotencyKey) {
    requestHash = hashRequest(input);
    const reservation = reserveIdempotencyKey(store, idempotencyKey, requestHash);
    if (reservation.outcome === "hash_mismatch") {
      throw httpError(422, "Idempotency-Key was already used with a different request body", "idempotency_key_reuse");
    }
    if (reservation.outcome === "in_progress") {
      throw httpError(409, "A request with this Idempotency-Key is already being processed", "idempotency_in_progress");
    }
    if (reservation.outcome === "done") {
      return findPayment(reservation.paymentId);
    }
    // outcome === "reserved": this call owns the key and must complete or release it.
  }
  const reference = allocateReference(store);

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
      reference,
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

    store.state.payments.unshift(payment);
    store.save();
    if (idempotencyKey) {
      completeIdempotencyKey(store, idempotencyKey, payment.id);
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
      releaseIdempotencyKey(store, idempotencyKey);
    }
    throw error;
  }
}

async function approvePayment(id) {
  const payment = findPayment(id);
  if (["Approved", "Executing", "Settled"].includes(payment.status)) {
    return payment;
  }
  if (payment.status !== "Pending approval") {
    throw httpError(409, `Payment ${payment.reference} is not pending approval`, "invalid_state");
  }

  const evaluation = await evaluatePayment(payment);
  if (evaluation.decision.status === "Blocked") {
    payment.status = "Blocked";
    store.save();
    await audit("Policy engine", "Payment blocked", payment.reference, evaluation.decision.detail);
    return payment;
  }
  if (evaluation.decision.status === "Review") {
    throw httpError(409, `Payment ${payment.reference} requires review before approval`, "review_required");
  }

  payment.approvals += 1;
  payment.status = payment.approvals >= payment.requiredApprovals ? "Approved" : "Pending approval";
  store.save();
  await audit("Marta Klein", "Payment approved", payment.reference, `${payment.approvals}/${payment.requiredApprovals} approvals`);
  return payment;
}

async function executePayment(id) {
  const payment = findPayment(id);
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
      payment.status = "Blocked";
      store.save();
      await audit("Policy engine", "Execution blocked", payment.reference, evaluation.decision.detail);
      return payment;
    }
    if (evaluation.decision.status === "Review") {
      throw httpError(409, `Payment ${payment.reference} requires review before execution`, "review_required");
    }

    payment.status = "Executing";
    store.save();
  }

  try {
    await servicePost(
      "wallet",
      `/wallets/${payment.sourceWalletId}/debit`,
      { amount: payment.amount + payment.fee },
      { idempotencyKey: `debit:${payment.id}` }
    );
  } catch (error) {
    if (error.status === 409) {
      payment.status = "Failed";
      store.save();
    }
    throw error;
  }

  payment.providerRef ||= `ARC-${randomHex(5)}`;
  payment.chainRef ||= `0x${randomHex(14).toLowerCase()}`;
  store.save();

  await servicePost("accounting", "/journals/from-payment", { payment, ...context });
  await servicePost("reconciliation", "/reconciliation/matched", { payment });

  payment.status = "Settled";
  payment.settledAt ||= new Date().toISOString();
  store.save();
  await audit("Arcadia Custody Bank", "Payment settled", payment.reference, `Provider reference ${payment.providerRef}`);
  return payment;
}

async function cancelPayment(id) {
  const payment = findPayment(id);
  if (payment.status === "Cancelled") {
    return payment;
  }
  if (!["Pending approval", "Approved"].includes(payment.status)) {
    throw httpError(409, `Payment ${payment.reference} cannot be cancelled`, "invalid_state");
  }
  payment.status = "Cancelled";
  store.save();
  await audit("Marta Klein", "Payment cancelled", payment.reference, "User cancelled payment before execution");
  return payment;
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

function findPayment(id) {
  const payment = store.state.payments.find((entry) => entry.id === id);
  if (!payment) {
    throw httpError(404, `payment ${id} not found`, "not_found");
  }
  return payment;
}

function highestReferenceIn(payments) {
  return payments.reduce((highest, payment) => {
    const value = Number(String(payment.reference).replace(/\D/g, ""));
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 1000);
}
