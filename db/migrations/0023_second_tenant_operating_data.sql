-- Tenant 2 operating data for end-to-end tenant-isolation verification.

INSERT INTO operations.providers
  (id, tenant_id, name, type, jurisdiction, authority, status, latency_ms, uptime, assets, routes, incident)
VALUES
  ('prov-nordic-custody', '00000000-0000-0000-0000-000000000002', 'Nordic Custody Bank', 'Custody and settlement', 'SE', 'Finansinspektionen', 'Operational', 365, 99.94, ARRAY['N-EURC', 'N-USDC'], ARRAY['Nordic supplier rail', 'SEPA off-ramp'], ''),
  ('prov-nordic-fx', '00000000-0000-0000-0000-000000000002', 'Nordic FX Desk', 'FX and conversion', 'DK', 'Danish FSA', 'Operational', 430, 99.88, ARRAY['N-USDC', 'N-EURC'], ARRAY['EUR/USD', 'USD/EUR'], ''),
  ('prov-nordic-screen', '00000000-0000-0000-0000-000000000002', 'Nordic Screening Node', 'AML and sanctions', 'SE', 'Finansinspektionen', 'Operational', 250, 99.97, ARRAY[]::TEXT[], ARRAY['Address screening'], '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallet.legal_entities
  (id, tenant_id, name, jurisdiction, base_currency, erp_code)
VALUES
  ('ent-nordic-hold', '00000000-0000-0000-0000-000000000002', 'Nordic Holdings AB', 'SE', 'EUR', 'NORDIC-0001'),
  ('ent-nordic-fi', '00000000-0000-0000-0000-000000000002', 'Nordic Finland Oy', 'FI', 'EUR', 'NORDIC-2100')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallet.assets
  (id, tenant_id, name, currency, issuer, chain, classification, status, risk, provider_id)
VALUES
  ('N-EURC', '00000000-0000-0000-0000-000000000002', 'Nordic Euro EMT', 'EUR', 'Nordic EMI', 'Polygon', 'Cash equivalent', 'Enabled', 'Low', 'prov-nordic-custody'),
  ('N-USDC', '00000000-0000-0000-0000-000000000002', 'Nordic USD Stablecoin', 'USD', 'Circle', 'Ethereum', 'Financial asset', 'Enabled', 'Medium', 'prov-nordic-fx')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallet.wallets
  (id, tenant_id, entity_id, provider_id, asset_id, address, custody, status)
VALUES
  ('wal-nordic-eur', '00000000-0000-0000-0000-000000000002', 'ent-nordic-hold', 'prov-nordic-custody', 'N-EURC', '0xnd01...e001', 'Segregated client account', 'Active'),
  ('wal-nordic-usd', '00000000-0000-0000-0000-000000000002', 'ent-nordic-fi', 'prov-nordic-fx', 'N-USDC', '0xnd02...u001', 'Partner CASP wallet', 'Active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO policy.policies
  (tenant_id, approval_threshold, second_approval_threshold, hard_transfer_limit, concentration_limit, allowed_assets, allowed_providers, require_screening)
VALUES
  ('00000000-0000-0000-0000-000000000002', 40000, 200000, 500000, 0.65, ARRAY['N-EURC', 'N-USDC'], ARRAY['prov-nordic-custody', 'prov-nordic-fx'], true)
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO compliance.counterparties
  (id, tenant_id, name, type, jurisdiction, status, risk, asset, wallet_address)
VALUES
  ('cp-nordic-steel', '00000000-0000-0000-0000-000000000002', 'Nordic Steel AS', 'Supplier', 'NO', 'Approved', 'Low', 'N-EURC', '0xns01...7100'),
  ('cp-nordic-review', '00000000-0000-0000-0000-000000000002', 'Baltic Review Logistics', 'Logistics', 'EE', 'Review', 'Medium', 'N-USDC', '0xbr01...2200')
ON CONFLICT (id) DO NOTHING;

INSERT INTO operations.audit_events
  (id, tenant_id, actor, action, object, detail)
VALUES
  ('aud-nordic-seed-1', '00000000-0000-0000-0000-000000000002', 'System', 'Tenant seeded', 'Nordic Holdings AB', 'Initial tenant 2 operating dataset loaded')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  tenant UUID := '00000000-0000-0000-0000-000000000002';
  wallet_account UUID;
  opening_account UUID;
  tx_id UUID;
BEGIN
  INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
  VALUES (tenant, 'wal-nordic-eur', 'wallet', 'N-EURC')
  ON CONFLICT (tenant_id, wallet_id, account_type, asset_id) DO UPDATE SET asset_id = EXCLUDED.asset_id
  RETURNING id INTO wallet_account;

  INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
  VALUES (tenant, NULL, 'opening_balance', 'N-EURC')
  ON CONFLICT (tenant_id, account_type, asset_id) WHERE wallet_id IS NULL DO UPDATE SET asset_id = EXCLUDED.asset_id
  RETURNING id INTO opening_account;

  INSERT INTO wallet.ledger_transactions (tenant_id, idempotency_key, description, payment_id)
  VALUES (tenant, 'seed-opening-balance:wal-nordic-eur', 'Seed opening balance for wal-nordic-eur', NULL)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id INTO tx_id;

  IF tx_id IS NOT NULL THEN
    INSERT INTO wallet.ledger_entries (transaction_id, account_id, direction, amount)
    VALUES
      (tx_id, opening_account, 'debit', 520000),
      (tx_id, wallet_account, 'credit', 520000);
  END IF;

  INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
  VALUES (tenant, 'wal-nordic-usd', 'wallet', 'N-USDC')
  ON CONFLICT (tenant_id, wallet_id, account_type, asset_id) DO UPDATE SET asset_id = EXCLUDED.asset_id
  RETURNING id INTO wallet_account;

  INSERT INTO wallet.ledger_accounts (tenant_id, wallet_id, account_type, asset_id)
  VALUES (tenant, NULL, 'opening_balance', 'N-USDC')
  ON CONFLICT (tenant_id, account_type, asset_id) WHERE wallet_id IS NULL DO UPDATE SET asset_id = EXCLUDED.asset_id
  RETURNING id INTO opening_account;

  INSERT INTO wallet.ledger_transactions (tenant_id, idempotency_key, description, payment_id)
  VALUES (tenant, 'seed-opening-balance:wal-nordic-usd', 'Seed opening balance for wal-nordic-usd', NULL)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id INTO tx_id;

  IF tx_id IS NOT NULL THEN
    INSERT INTO wallet.ledger_entries (transaction_id, account_id, direction, amount)
    VALUES
      (tx_id, opening_account, 'debit', 180000),
      (tx_id, wallet_account, 'credit', 180000);
  END IF;
END $$;
