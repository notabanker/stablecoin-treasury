import { ratesToEur } from "../../../packages/shared/data.mjs";

export function requiredApprovalsFor(amount, asset, policy) {
  const amountEur = amount * (ratesToEur[asset] || 1);
  if (amountEur >= policy.secondApprovalThreshold) {
    return 2;
  }
  if (amountEur >= policy.approvalThreshold) {
    return 1;
  }
  return 0;
}
