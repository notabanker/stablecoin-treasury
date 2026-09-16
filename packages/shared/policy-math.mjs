import { moneyNumber } from "./money.mjs";

// Demo FX rates to EUR. A single source for policy evaluation, approval routing, and
// the web state payload.
export const ratesToEur = {
  EURC: 1,
  EURI: 1,
  "N-EURC": 1,
  "N-USDC": 0.92,
  USDC: 0.92,
  USDG: 0.92
};

export function valueToEur(amount, asset) {
  return moneyNumber(amount || 0) * (ratesToEur[asset] || 1);
}

// Approval count for an amount already converted to EUR, per the tenant policy thresholds.
export function requiredApprovalsFor(amountEur, policy) {
  if (amountEur >= policy.secondApprovalThreshold) return 2;
  if (amountEur >= policy.approvalThreshold) return 1;
  return 0;
}
