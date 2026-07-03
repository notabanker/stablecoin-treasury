-- Repair retry needs to move a failed payment back into Executing before enqueueing a fresh
-- execute-payment job. Migration 0012 predated the repair endpoint and did not include that
-- transition, so failed-payment retry would be rejected by the database trigger.

CREATE OR REPLACE FUNCTION payment.enforce_and_log_transition() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO payment.payment_events (tenant_id, payment_id, from_status, to_status, actor, at)
    VALUES (NEW.tenant_id, NEW.id, NULL, NEW.status, 'system', now());
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
    ('Pending approval', 'Approved'),
    ('Pending approval', 'Blocked'),
    ('Pending approval', 'Cancelled'),
    ('Approved', 'Executing'),
    ('Approved', 'Blocked'),
    ('Approved', 'Cancelled'),
    ('Executing', 'Settled'),
    ('Executing', 'Failed'),
    ('Failed', 'Executing')
  ) THEN
    RAISE EXCEPTION 'Invalid payment status transition for %: % -> %', NEW.id, OLD.status, NEW.status;
  END IF;

  INSERT INTO payment.payment_events (tenant_id, payment_id, from_status, to_status, actor, at)
  VALUES (NEW.tenant_id, NEW.id, OLD.status, NEW.status, 'system', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
