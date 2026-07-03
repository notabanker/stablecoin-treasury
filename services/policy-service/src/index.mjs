import { createSeedData, ratesToEur, roundMoney } from "../../../packages/shared/data.mjs";
import { createJsonService, httpError, ok, route } from "../../../packages/shared/http.mjs";
import { createDurableStore } from "../../../packages/shared/store.mjs";

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

function evaluate({ payment, wallet, wallets, asset, counterparty, provider }, policies) {
  if (!payment || !wallet || !asset || !counterparty || !provider) {
    throw httpError(422, "Payment, wallet, asset, counterparty, and provider are required", "missing_context");
  }
  const amountEur = valueToEur(payment.amount, payment.asset);
  const expectedApprovals = requiredApprovalsFor(amountEur, policies);
  const concentration = Array.isArray(wallets)
    ? assetConcentrationAfterPayment(wallets, payment)
    : { current: 0, projected: 0 };

  const checks = [
    {
      label: "Asset allowlist",
      status: policies.allowedAssets.includes(payment.asset) && asset.status === "Enabled" ? "Clear" : "Blocked",
      detail: `${payment.asset} is ${asset.status.toLowerCase()} and ${policies.allowedAssets.includes(payment.asset) ? "allowed" : "not allowlisted"}`
    },
    {
      label: "Provider route",
      status: !policies.allowedProviders.includes(provider.id) ? "Blocked" : provider.status === "Operational" ? "Clear" : "Review",
      detail: `${provider.name} is ${policies.allowedProviders.includes(provider.id) ? "allowlisted" : "not allowlisted"} and ${provider.status.toLowerCase()}`
    },
    {
      label: "Balance",
      status: wallet.balance >= payment.amount + payment.fee ? "Clear" : "Blocked",
      detail: `${wallet.balance} ${payment.asset} available in source wallet`
    },
    {
      label: "Counterparty screening",
      status: !policies.requireScreening ? "Clear" : counterparty.status === "Approved" ? "Clear" : counterparty.status === "Blocked" ? "Blocked" : "Review",
      detail: policies.requireScreening ? `${counterparty.name} status is ${counterparty.status.toLowerCase()}` : "Screening is not required by current policy"
    },
    {
      label: "Transfer limit",
      status: amountEur <= policies.hardTransferLimit ? "Clear" : "Blocked",
      detail: `${roundMoney(amountEur)} EUR equivalent against hard limit ${policies.hardTransferLimit}`
    },
    {
      label: "Approval threshold",
      status: payment.requiredApprovals >= expectedApprovals ? "Clear" : "Blocked",
      detail: `${expectedApprovals} approval${expectedApprovals === 1 ? "" : "s"} required`
    },
    {
      label: "Concentration limit",
      status: concentration.projected <= policies.concentrationLimit || concentration.projected <= concentration.current ? "Clear" : "Review",
      detail: `${Math.round(concentration.projected * 100)}% ${payment.asset} concentration after payment against ${Math.round(policies.concentrationLimit * 100)}% limit`
    }
  ];

  const blocked = checks.find((check) => check.status === "Blocked");
  const review = checks.find((check) => check.status === "Review");
  return {
    checks,
    decision: blocked
      ? { status: "Blocked", detail: blocked.detail }
      : review
        ? { status: "Review", detail: review.detail }
        : { status: "Clear", detail: "All active rules passed" }
  };
}

function numberOr(fallback, value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validatePolicy(policy) {
  const numericFields = ["approvalThreshold", "secondApprovalThreshold", "hardTransferLimit", "concentrationLimit"];
  for (const field of numericFields) {
    if (!Number.isFinite(policy[field])) {
      throw httpError(422, `${field} must be a number`, "invalid_policy");
    }
  }
  if (policy.approvalThreshold < 0 || policy.secondApprovalThreshold < 0 || policy.hardTransferLimit <= 0) {
    throw httpError(422, "Policy thresholds must be non-negative and hardTransferLimit must be positive", "invalid_policy");
  }
  if (policy.approvalThreshold > policy.secondApprovalThreshold) {
    throw httpError(422, "approvalThreshold cannot exceed secondApprovalThreshold", "invalid_policy");
  }
  if (policy.concentrationLimit <= 0 || policy.concentrationLimit > 1) {
    throw httpError(422, "concentrationLimit must be greater than 0 and no more than 1", "invalid_policy");
  }
}

function requiredApprovalsFor(amountEur, policies) {
  if (amountEur >= policies.secondApprovalThreshold) {
    return 2;
  }
  if (amountEur >= policies.approvalThreshold) {
    return 1;
  }
  return 0;
}

function valueToEur(amount, asset) {
  return Number(amount || 0) * (ratesToEur[asset] || 1);
}

function assetConcentrationAfterPayment(wallets, payment) {
  const outgoing = valueToEur(Number(payment.amount || 0) + Number(payment.fee || 0), payment.asset);
  const totalBefore = wallets.reduce((sum, item) => sum + valueToEur(item.balance, item.asset), 0);
  const assetBefore = wallets
    .filter((item) => item.asset === payment.asset)
    .reduce((sum, item) => sum + valueToEur(item.balance, item.asset), 0);
  const totalAfter = Math.max(roundMoney(totalBefore - outgoing), 0);
  const assetAfter = Math.max(roundMoney(assetBefore - outgoing), 0);
  return {
    current: totalBefore ? assetBefore / totalBefore : 0,
    projected: totalAfter ? assetAfter / totalAfter : 0
  };
}
