import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Money, parseMoneyInput } from "./money.mjs";
import { DEFAULT_TENANT_ID } from "./tenant.mjs";

const NORDIC_DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000002";

// Static demo fixtures live in seed-data.json; the handful of timestamp fields the UI renders
// as relative ages are stamped at call time below.
const SEED_DATA = JSON.parse(readFileSync(new URL("./seed-data.json", import.meta.url), "utf8"));

export function createSeedData(tenantId = DEFAULT_TENANT_ID) {
  if (tenantId === NORDIC_DEMO_TENANT_ID) return nordicSeed();
  if (tenantId !== DEFAULT_TENANT_ID) return emptySeed();
  return vegaSeed();
}

function vegaSeed() {
  const now = new Date().toISOString();
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const data = structuredClone(SEED_DATA.default);
  data.lastUpdated = now;
  data.reconciliation[0].createdAt = hoursAgo(0.1);
  data.reconciliation[0].resolvedAt = now;
  data.reconciliation[1].createdAt = hoursAgo(4.5);
  return data;
}

function nordicSeed() {
  const data = structuredClone(SEED_DATA.nordic);
  data.lastUpdated = new Date().toISOString();
  data.audit[0].at = data.lastUpdated;
  return data;
}

function emptySeed() {
  return {
    lastUpdated: new Date().toISOString(),
    currentUser: null,
    policies: null,
    entities: [],
    assets: [],
    providers: [],
    wallets: [],
    counterparties: [],
    payments: [],
    reconciliation: [],
    journalEntries: [],
    audit: [],
    alerts: []
  };
}

/** Durable entity id: prefix + crypto UUID (not Math.random). */
export function createId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Estimate network/provider fee in major units (cent-rounded).
 * Uses Money so 1000 * 0.00009 + base does not accumulate float noise.
 */
export function estimateFee(amount, asset) {
  const principal = amount instanceof Money ? amount : parseMoneyInput(amount ?? 0);
  const base = Money.fromString(asset === "USDC" ? "3.20" : "2.40");
  return principal.times(0.00009).plus(base).toNumber();
}
