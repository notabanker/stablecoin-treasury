// Provider adapter interface (V3.6).
// Each capability is a function that a real provider adapter (Arcadia, Meridian, etc.)
// would implement with real API calls. Until M5 real integrations, the simulated adapter
// returns plausible fake data so the saga and reconciliation engine can be tested end-to-end.

export const PROVIDER_CAPABILITIES = {
  CUSTODY: "custody",
  SCREENING: "screening",
  FX: "fx",
  BANKING: "banking",
  ERP: "erp"
};

// Simulated custody adapter — used by the payment saga for step 3 (provider submission).
export function simulatedCustodyAdapter(provider) {
  return {
    getBalances: async () => [
      { asset: "EURC", balance: 1000000 },
      { asset: "USDC", balance: 500000 }
    ],
    submitTransfer: async ({ amount, asset, destination }) => ({
      providerRef: `ARC-${Math.random().toString(16).slice(2, 7).toUpperCase()}`,
      chainRef: `0x${Math.random().toString(16).slice(2, 16).toUpperCase()}`,
      status: "submitted",
      estimatedSettlementMs: 5000
    }),
    getTransferStatus: async (providerRef) => ({
      providerRef,
      status: "settled",
      settledAt: new Date().toISOString()
    }),
    provider
  };
}

// Simulated screening adapter
export function simulatedScreeningAdapter() {
  return {
    screenCounterparty: async ({ name, jurisdiction, wallet }) => ({
      result: "Clear",
      risk: "Low",
      provider: "Sentinel Chain Analytics (simulated)",
      screenedAt: new Date().toISOString()
    }),
    screenTransaction: async ({ amount, asset, counterparty, wallet }) => ({
      result: "Clear",
      risk: "Low",
      provider: "Sentinel Chain Analytics (simulated)",
      screenedAt: new Date().toISOString()
    })
  };
}

// Simulated FX adapter
export function simulatedFxAdapter() {
  return {
    getQuote: async ({ fromAsset, toAsset, amount }) => ({
      fromAsset,
      toAsset,
      fromAmount: amount,
      toAmount: amount * 1.08, // fake EUR/USD rate
      rate: 1.08,
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }),
    execute: async (quoteId) => ({
      quoteId,
      status: "executed",
      settledAt: new Date().toISOString()
    })
  };
}
