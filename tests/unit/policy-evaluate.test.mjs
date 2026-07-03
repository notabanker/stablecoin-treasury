import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, requiredApprovalsFor, validatePolicy } from "../../services/policy-service/src/evaluate.mjs";

const policies = {
  allowedAssets: ["EURC", "USDC"],
  allowedProviders: ["prov-arcadia", "prov-meridian"],
  approvalThreshold: 50000,
  concentrationLimit: 0.55,
  hardTransferLimit: 750000,
  requireScreening: true,
  secondApprovalThreshold: 250000
};

const baseWallet = { balance: 100000, asset: "EURC" };
const baseAsset = { status: "Enabled" };
const baseCounterparty = { name: "Nordic", status: "Approved" };
const baseProvider = { id: "prov-arcadia", name: "Arcadia", status: "Operational" };

function basePayment(overrides = {}) {
  return { amount: 1000, asset: "EURC", fee: 1, requiredApprovals: 0, ...overrides };
}

test("evaluate clears a well-formed low-value payment", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: baseAsset, counterparty: baseCounterparty, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Clear");
});

test("evaluate blocks assets not on the allowlist", () => {
  const result = evaluate(
    {
      payment: basePayment({ asset: "EURI" }),
      wallet: { ...baseWallet, asset: "EURI" },
      asset: baseAsset,
      counterparty: baseCounterparty,
      provider: baseProvider
    },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate blocks disabled assets even if allowlisted", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: { status: "Reporting only" }, counterparty: baseCounterparty, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate blocks a provider not on the provider allowlist", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: baseAsset, counterparty: baseCounterparty, provider: { id: "prov-unknown", name: "X", status: "Operational" } },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate reviews a degraded but allowlisted provider", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: baseAsset, counterparty: baseCounterparty, provider: { ...baseProvider, status: "Degraded" } },
    policies
  );
  assert.equal(result.decision.status, "Review");
});

test("evaluate blocks insufficient balance", () => {
  const result = evaluate(
    { payment: basePayment({ amount: 999999 }), wallet: baseWallet, asset: baseAsset, counterparty: baseCounterparty, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate blocks a blocked counterparty", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: baseAsset, counterparty: { name: "Baltic", status: "Blocked" }, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate reviews a counterparty pending screening", () => {
  const result = evaluate(
    { payment: basePayment(), wallet: baseWallet, asset: baseAsset, counterparty: { name: "Orion", status: "Review" }, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Review");
});

test("evaluate skips screening entirely when requireScreening is false", () => {
  const result = evaluate(
    {
      payment: basePayment(),
      wallet: baseWallet,
      asset: baseAsset,
      counterparty: { name: "Orion", status: "Review" },
      provider: baseProvider
    },
    { ...policies, requireScreening: false }
  );
  assert.equal(result.decision.status, "Clear");
});

test("evaluate blocks amounts over the EUR-converted hard transfer limit", () => {
  const result = evaluate(
    { payment: basePayment({ amount: 800000, requiredApprovals: 2 }), wallet: { ...baseWallet, balance: 900000 }, asset: baseAsset, counterparty: baseCounterparty, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate converts non-EUR assets before comparing to the hard limit", () => {
  // USDC is 0.92 EUR; 800000 USDC ~ 736000 EUR, under the 750000 EUR hard limit.
  const result = evaluate(
    {
      payment: basePayment({ amount: 800000, asset: "USDC", requiredApprovals: 2 }),
      wallet: { balance: 900000, asset: "USDC" },
      asset: baseAsset,
      counterparty: baseCounterparty,
      provider: baseProvider
    },
    policies
  );
  assert.notEqual(result.checks.find((c) => c.label === "Transfer limit").status, "Blocked");
});

test("evaluate blocks when requiredApprovals is under-declared for the amount", () => {
  const result = evaluate(
    { payment: basePayment({ amount: 60000, requiredApprovals: 0 }), wallet: baseWallet, asset: baseAsset, counterparty: baseCounterparty, provider: baseProvider },
    policies
  );
  assert.equal(result.decision.status, "Blocked");
});

test("evaluate reviews when draining one asset concentrates the book in another", () => {
  // Before: EURC 90000 / USDC-in-EUR 80000, total 170000 -> max share 0.529 (under the 0.55 limit).
  // Paying out 70000 EURC leaves EURC 20000 / USDC 80000, total 100000 -> USDC share jumps to
  // 0.80, over the limit and higher than the pre-payment max -- this must not self-clear via the
  // "already this concentrated" escape hatch, because concentration is *increasing*.
  const wallets = [
    { balance: 90000, asset: "EURC" },
    { balance: 80000 / 0.92, asset: "USDC" }
  ];
  const result = evaluate(
    {
      payment: basePayment({ amount: 70000, fee: 0, requiredApprovals: 1 }),
      wallet: { balance: 200000, asset: "EURC" },
      asset: baseAsset,
      counterparty: baseCounterparty,
      provider: baseProvider,
      wallets
    },
    policies
  );
  assert.equal(result.decision.status, "Review");
});

test("evaluate does not flag concentration that is already high but decreasing", () => {
  const wallets = [
    { balance: 100000, asset: "EURC" },
    { balance: 5000, asset: "USDC" }
  ];
  const result = evaluate(
    {
      payment: basePayment({ amount: 90000, fee: 0, requiredApprovals: 2 }),
      wallet: { balance: 200000, asset: "EURC" },
      asset: baseAsset,
      counterparty: baseCounterparty,
      provider: baseProvider,
      wallets
    },
    policies
  );
  assert.notEqual(result.decision.status, "Blocked");
});

test("requiredApprovalsFor boundary values", () => {
  assert.equal(requiredApprovalsFor(49999, policies), 0);
  assert.equal(requiredApprovalsFor(50000, policies), 1);
  assert.equal(requiredApprovalsFor(249999, policies), 1);
  assert.equal(requiredApprovalsFor(250000, policies), 2);
});

test("validatePolicy rejects negative thresholds", () => {
  assert.throws(() => validatePolicy({ ...policies, approvalThreshold: -1 }));
});

test("validatePolicy rejects approvalThreshold above secondApprovalThreshold", () => {
  assert.throws(() => validatePolicy({ ...policies, approvalThreshold: 300000, secondApprovalThreshold: 250000 }));
});

test("validatePolicy rejects concentrationLimit outside (0, 1]", () => {
  assert.throws(() => validatePolicy({ ...policies, concentrationLimit: 0 }));
  assert.throws(() => validatePolicy({ ...policies, concentrationLimit: 1.5 }));
  assert.doesNotThrow(() => validatePolicy({ ...policies, concentrationLimit: 1 }));
});

test("validatePolicy rejects a non-positive hardTransferLimit", () => {
  assert.throws(() => validatePolicy({ ...policies, hardTransferLimit: 0 }));
});
