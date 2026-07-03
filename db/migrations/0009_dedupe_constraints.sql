-- Both accounting's "create journals for this payment if none exist" and reconciliation's
-- "create a Matched row for this payment if none exists" were select-then-insert in application
-- code with no database backstop -- two concurrent calls (a realistic outcome of the payment
-- service's own execute() being called twice while resuming from "Executing") could both pass
-- the "none exist" check before either INSERT commits, producing duplicate journal batches or
-- duplicate matched rows. These constraints make the duplicate impossible to write, not just
-- unlikely; the application catches the resulting unique-violation and treats it as the
-- idempotent-replay case.

ALTER TABLE accounting.journal_entries
  ADD CONSTRAINT journal_entries_payment_account_uniq UNIQUE (tenant_id, payment_id, account);

CREATE UNIQUE INDEX reconciliation_rows_matched_once_per_payment
  ON reconciliation.reconciliation_rows (tenant_id, payment_id)
  WHERE issue = 'Matched';
