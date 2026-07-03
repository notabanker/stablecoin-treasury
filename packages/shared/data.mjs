export const ratesToEur = {
  EURC: 1,
  EURI: 1,
  USDC: 0.92,
  USDG: 0.92
};

export function createSeedData() {
  const now = new Date().toISOString();
  return {
    lastUpdated: now,
    currentUser: {
      id: "usr-1",
      name: "Marta Klein",
      role: "Group Treasury Admin"
    },
    policies: {
      approvalThreshold: 50000,
      secondApprovalThreshold: 250000,
      hardTransferLimit: 750000,
      concentrationLimit: 0.55,
      allowedAssets: ["EURC", "USDC"],
      allowedProviders: ["prov-arcadia", "prov-meridian", "prov-atlas"],
      requireScreening: true
    },
    entities: [
      {
        id: "ent-hold",
        name: "Vega Industries SE",
        jurisdiction: "DE",
        baseCurrency: "EUR",
        erpCode: "SAP-0001"
      },
      {
        id: "ent-de",
        name: "Vega Germany GmbH",
        jurisdiction: "DE",
        baseCurrency: "EUR",
        erpCode: "SAP-1100"
      },
      {
        id: "ent-pl",
        name: "Vega Poland Sp. z o.o.",
        jurisdiction: "PL",
        baseCurrency: "PLN",
        erpCode: "SAP-2200"
      },
      {
        id: "ent-nl",
        name: "Vega Logistics BV",
        jurisdiction: "NL",
        baseCurrency: "EUR",
        erpCode: "SAP-3100"
      }
    ],
    assets: [
      {
        id: "EURC",
        name: "Euro EMT",
        currency: "EUR",
        issuer: "EuroMint EMI",
        chain: "Polygon",
        classification: "Cash equivalent",
        status: "Enabled",
        risk: "Low",
        providerId: "prov-arcadia"
      },
      {
        id: "USDC",
        name: "USD Stablecoin",
        currency: "USD",
        issuer: "Circle",
        chain: "Ethereum",
        classification: "Financial asset",
        status: "Enabled",
        risk: "Medium",
        providerId: "prov-meridian"
      },
      {
        id: "EURI",
        name: "Bank Settlement Token",
        currency: "EUR",
        issuer: "Atlas Bank",
        chain: "Permissioned",
        classification: "Cash equivalent",
        status: "Reporting only",
        risk: "Low",
        providerId: "prov-atlas"
      }
    ],
    providers: [
      {
        id: "prov-arcadia",
        name: "Arcadia Custody Bank",
        type: "Custody and settlement",
        jurisdiction: "LU",
        authority: "CSSF",
        status: "Operational",
        latencyMs: 348,
        uptime: 99.96,
        assets: ["EURC", "USDC"],
        routes: ["EU intra-group", "SEPA Instant off-ramp"],
        incident: ""
      },
      {
        id: "prov-meridian",
        name: "Meridian Markets CASP",
        type: "FX and conversion",
        jurisdiction: "IE",
        authority: "Central Bank of Ireland",
        status: "Operational",
        latencyMs: 412,
        uptime: 99.91,
        assets: ["USDC", "EURC"],
        routes: ["EUR/USD", "USD/EUR"],
        incident: ""
      },
      {
        id: "prov-atlas",
        name: "Atlas Bank Tokens",
        type: "Issuer sandbox",
        jurisdiction: "FR",
        authority: "ACPR",
        status: "Degraded",
        latencyMs: 885,
        uptime: 98.74,
        assets: ["EURI"],
        routes: ["Wholesale settlement"],
        incident: "Delayed sandbox callbacks"
      },
      {
        id: "prov-sentinel",
        name: "Sentinel Chain Analytics",
        type: "AML and sanctions",
        jurisdiction: "NL",
        authority: "DNB",
        status: "Operational",
        latencyMs: 276,
        uptime: 99.98,
        assets: [],
        routes: ["Address screening", "Transaction monitoring"],
        incident: ""
      }
    ],
    wallets: [
      {
        id: "wal-hold-eur",
        entityId: "ent-hold",
        providerId: "prov-arcadia",
        asset: "EURC",
        address: "0x9b31...44e1",
        custody: "Segregated client account",
        status: "Active",
        balance: 860000
      },
      {
        id: "wal-de-eur",
        entityId: "ent-de",
        providerId: "prov-arcadia",
        asset: "EURC",
        address: "0x63ad...91bc",
        custody: "Segregated client account",
        status: "Active",
        balance: 315000
      },
      {
        id: "wal-pl-eur",
        entityId: "ent-pl",
        providerId: "prov-arcadia",
        asset: "EURC",
        address: "0x810a...17ca",
        custody: "Segregated client account",
        status: "Active",
        balance: 172500
      },
      {
        id: "wal-nl-usd",
        entityId: "ent-nl",
        providerId: "prov-meridian",
        asset: "USDC",
        address: "0xc51f...7ae3",
        custody: "Partner CASP wallet",
        status: "Active",
        balance: 430000
      }
    ],
    counterparties: [
      {
        id: "cp-nordic",
        name: "Nordic Components AB",
        type: "Supplier",
        jurisdiction: "SE",
        status: "Approved",
        risk: "Low",
        asset: "EURC",
        wallet: "0x77bd...9aa1"
      },
      {
        id: "cp-orion",
        name: "Orion Plastics Ltd",
        type: "Supplier",
        jurisdiction: "GB",
        status: "Review",
        risk: "Medium",
        asset: "USDC",
        wallet: "0x10dc...02bb"
      },
      {
        id: "cp-vega-pl",
        name: "Vega Poland Sp. z o.o.",
        type: "Intra-group",
        jurisdiction: "PL",
        status: "Approved",
        risk: "Low",
        asset: "EURC",
        wallet: "0x810a...17ca"
      },
      {
        id: "cp-baltic",
        name: "Baltic Freight OU",
        type: "Logistics",
        jurisdiction: "EE",
        status: "Blocked",
        risk: "High",
        asset: "EURC",
        wallet: "0x42fa...aa00"
      }
    ],
    payments: [
      {
        id: "pay-1001",
        reference: "PMT-1001",
        type: "Supplier",
        sourceWalletId: "wal-de-eur",
        counterpartyId: "cp-nordic",
        asset: "EURC",
        amount: 42000,
        fee: 12.4,
        status: "Settled",
        approvals: 1,
        requiredApprovals: 1,
        screenResult: "Clear",
        createdAt: "2026-07-01T09:20:00.000Z",
        settledAt: "2026-07-01T09:27:00.000Z",
        providerRef: "ARC-27A91",
        chainRef: "0x9f17f1242d8a",
        memo: "Invoice INV-8841"
      },
      {
        id: "pay-1002",
        reference: "PMT-1002",
        type: "Intra-group",
        sourceWalletId: "wal-hold-eur",
        counterpartyId: "cp-vega-pl",
        asset: "EURC",
        amount: 210000,
        fee: 18.2,
        status: "Pending approval",
        approvals: 0,
        requiredApprovals: 1,
        screenResult: "Clear",
        createdAt: "2026-07-02T08:35:00.000Z",
        settledAt: "",
        providerRef: "",
        chainRef: "",
        memo: "Weekly operating liquidity"
      },
      {
        id: "pay-1003",
        reference: "PMT-1003",
        type: "Supplier",
        sourceWalletId: "wal-nl-usd",
        counterpartyId: "cp-orion",
        asset: "USDC",
        amount: 86000,
        fee: 22.7,
        status: "Pending approval",
        approvals: 0,
        requiredApprovals: 1,
        screenResult: "Review",
        createdAt: "2026-07-02T10:12:00.000Z",
        settledAt: "",
        providerRef: "",
        chainRef: "",
        memo: "Raw materials July"
      },
      {
        id: "pay-1004",
        reference: "PMT-1004",
        type: "Supplier",
        sourceWalletId: "wal-de-eur",
        counterpartyId: "cp-baltic",
        asset: "EURC",
        amount: 14000,
        fee: 0,
        status: "Blocked",
        approvals: 0,
        requiredApprovals: 1,
        screenResult: "Blocked",
        createdAt: "2026-07-02T11:18:00.000Z",
        settledAt: "",
        providerRef: "",
        chainRef: "",
        memo: "Screening block"
      }
    ],
    reconciliation: [
      {
        id: "rec-1",
        paymentId: "pay-1001",
        source: "On-chain event",
        issue: "Matched",
        amount: 42000,
        asset: "EURC",
        status: "Resolved",
        owner: "Auto",
        ageHours: 0.1
      },
      {
        id: "rec-2",
        paymentId: "pay-1003",
        source: "Provider callback",
        issue: "Screening review before execution",
        amount: 86000,
        asset: "USDC",
        status: "Open",
        owner: "Compliance Ops",
        ageHours: 4.5
      }
    ],
    journalEntries: [
      {
        id: "je-1",
        date: "2026-07-01",
        entityId: "ent-de",
        paymentId: "pay-1001",
        account: "Stablecoin cash equivalent",
        debit: 0,
        credit: 42012.4,
        currency: "EUR",
        status: "Ready"
      },
      {
        id: "je-2",
        date: "2026-07-01",
        entityId: "ent-de",
        paymentId: "pay-1001",
        account: "Supplier payable",
        debit: 42000,
        credit: 0,
        currency: "EUR",
        status: "Ready"
      },
      {
        id: "je-3",
        date: "2026-07-01",
        entityId: "ent-de",
        paymentId: "pay-1001",
        account: "Network and provider fees",
        debit: 12.4,
        credit: 0,
        currency: "EUR",
        status: "Ready"
      }
    ],
    audit: [
      {
        id: "aud-1",
        at: "2026-07-02T11:18:00.000Z",
        actor: "Sentinel Chain Analytics",
        action: "Payment blocked",
        object: "PMT-1004",
        detail: "Counterparty screening returned blocked status"
      },
      {
        id: "aud-2",
        at: "2026-07-02T10:12:00.000Z",
        actor: "Marta Klein",
        action: "Payment created",
        object: "PMT-1003",
        detail: "USDC 86,000 to Orion Plastics Ltd"
      },
      {
        id: "aud-3",
        at: "2026-07-02T08:35:00.000Z",
        actor: "Marta Klein",
        action: "Payment created",
        object: "PMT-1002",
        detail: "EURC 210,000 intra-group transfer"
      },
      {
        id: "aud-4",
        at: "2026-07-01T09:27:00.000Z",
        actor: "Arcadia Custody Bank",
        action: "Payment settled",
        object: "PMT-1001",
        detail: "Provider reference ARC-27A91"
      }
    ],
    alerts: [
      {
        id: "alt-1",
        severity: "Medium",
        title: "Atlas Bank Tokens callbacks delayed",
        detail: "Sandbox callbacks are delayed; routes remain reporting-only.",
        status: "Open"
      },
      {
        id: "alt-2",
        severity: "High",
        title: "Blocked counterparty attempt",
        detail: "Baltic Freight OU failed screening on PMT-1004.",
        status: "Open"
      }
    ]
  };
}

export function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function estimateFee(amount, asset) {
  const base = asset === "USDC" ? 3.2 : 2.4;
  return roundMoney(base + amount * 0.00009);
}

export function nextPaymentReference(payments) {
  const max = payments.reduce((highest, payment) => {
    const value = Number(String(payment.reference).replace(/\D/g, ""));
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 1000);
  return `PMT-${max + 1}`;
}

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function randomHex(length) {
  return Math.random().toString(16).slice(2, 2 + length).padEnd(length, "0").toUpperCase();
}
