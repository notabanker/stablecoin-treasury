import { valueToEur, requiredApprovalsFor as approvalsForEur } from "../../../packages/shared/policy-math.mjs";

// Amount + asset wrapper used when creating a payment.
export function requiredApprovalsFor(amount, asset, policy) {
  return approvalsForEur(valueToEur(amount, asset), policy);
}
