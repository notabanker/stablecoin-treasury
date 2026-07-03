-- The FKs from payment_events and payment_execution_attempts to payments were missing
-- ON DELETE CASCADE, so any bulk reset/cleanup that deletes payments would trip a
-- foreign-key violation. Drop and recreate both constraints with CASCADE so deleting
-- a payment (e.g. during reseed/reset) automatically clears its history.

ALTER TABLE payment.payment_events
  DROP CONSTRAINT IF EXISTS payment_events_payment_id_fkey;

ALTER TABLE payment.payment_events
  ADD CONSTRAINT payment_events_payment_id_fkey
    FOREIGN KEY (payment_id) REFERENCES payment.payments (id) ON DELETE CASCADE;

ALTER TABLE payment.payment_execution_attempts
  DROP CONSTRAINT IF EXISTS payment_execution_attempts_payment_id_fkey;

ALTER TABLE payment.payment_execution_attempts
  ADD CONSTRAINT payment_execution_attempts_payment_id_fkey
    FOREIGN KEY (payment_id) REFERENCES payment.payments (id) ON DELETE CASCADE;
