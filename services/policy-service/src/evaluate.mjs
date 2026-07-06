import { ratesToEur, roundMoney } from "../../../packages/shared/data.mjs";
import { httpError } from "../../../packages/shared/http.mjs";

export function evaluate({ payment, wallet, wallets, asset, counterparty, provider }, policies) {
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

export function numberOr(fallback, value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function validatePolicy(policy) {
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
  // selfApprovalAllowed defaults to false; any truthy value is accepted
  if (policy.selfApprovalAllowed !== undefined && typeof policy.selfApprovalAllowed !== "boolean") {
    throw httpError(422, "selfApprovalAllowed must be a boolean if provided", "invalid_policy");
  }
}

export function requiredApprovalsFor(amountEur, policies) {
  if (amountEur >= policies.secondApprovalThreshold) {
    return 2;
  }
  if (amountEur >= policies.approvalThreshold) {
    return 1;
  }
  return 0;
}

export function valueToEur(amount, asset) {
  return Number(amount || 0) * (ratesToEur[asset] || 1);
}

// Measures the largest single-asset share of total treasury value, before and after this
// payment. This is deliberately NOT "the payment asset's own share": subtracting the same
// outgoing amount from both a subset's total and the grand total can only ever shrink that
// subset's share (for any a <= b, (a-c)/(b-c) <= a/b), so a same-asset-share check can
// mathematically never detect a concentration increase from an outflow -- it would always
// self-clear. The real risk this control exists to catch is different: draining one asset
// while leaving another asset's wallets untouched can concentrate the *remaining* book in
// whatever wasn't spent, so we track the maximum share across all assets.
export function assetConcentrationAfterPayment(wallets, payment) {
  const outgoing = valueToEur(Number(payment.amount || 0) + Number(payment.fee || 0), payment.asset);
  const valueByAsset = new Map();
  for (const item of wallets) {
    const value = valueToEur(item.balance, item.asset);
    valueByAsset.set(item.asset, (valueByAsset.get(item.asset) || 0) + value);
  }
  const totalBefore = [...valueByAsset.values()].reduce((sum, value) => sum + value, 0);
  const currentMax = maxShare(valueByAsset, totalBefore);

  const valueByAssetAfter = new Map(valueByAsset);
  valueByAssetAfter.set(payment.asset, Math.max((valueByAssetAfter.get(payment.asset) || 0) - outgoing, 0));
  const totalAfter = Math.max(roundMoney(totalBefore - outgoing), 0);
  const projectedMax = maxShare(valueByAssetAfter, totalAfter);

  return { current: currentMax, projected: projectedMax };
}

function maxShare(valueByAsset, total) {
  if (!total) return 0;
  let max = 0;
  for (const value of valueByAsset.values()) {
    max = Math.max(max, value / total);
  }
  return max;
}
