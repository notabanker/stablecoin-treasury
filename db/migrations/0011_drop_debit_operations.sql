-- wallet.ledger_transactions (0010_ledger.sql) now provides the same idempotency guarantee this
-- table existed for, plus the actual double-entry postings; keeping both would be two sources of
-- truth for "has this debit already happened."
DROP TABLE IF EXISTS wallet.debit_operations;
