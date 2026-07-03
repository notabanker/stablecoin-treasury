CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting.journal_entries (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES identity.tenants (id),
  date DATE NOT NULL,
  entity_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  account TEXT NOT NULL,
  debit NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(20, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Ready', 'Exported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE INDEX IF NOT EXISTS journal_entries_payment_idx ON accounting.journal_entries (payment_id);

-- Deferred constraint trigger: a transaction may insert unbalanced rows mid-transaction (e.g.
-- inserting the debit line before the offsetting credit line), but every batch for a given
-- payment_id must balance by the time the transaction commits. This moves the assertBalanced()
-- application check (added in M0) into the database itself, so no future code path -- including
-- a raw SQL script -- can post an unbalanced batch.
CREATE OR REPLACE FUNCTION accounting.assert_batch_balanced() RETURNS TRIGGER AS $$
DECLARE
  imbalance NUMERIC;
BEGIN
  SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0)
  INTO imbalance
  FROM accounting.journal_entries
  WHERE payment_id = NEW.payment_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Journal batch for payment % is unbalanced by %', NEW.payment_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_balanced_trigger ON accounting.journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balanced_trigger
  AFTER INSERT ON accounting.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION accounting.assert_batch_balanced();
