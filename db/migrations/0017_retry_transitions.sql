-- Add retry and compensation transitions to the payment state machine trigger.
-- Failed→Executing: operator retries a failed execution via the repair API
-- Failed→Cancelled: operator compensates a failed execution

DROP TRIGGER IF EXISTS payment_transition_trigger ON payment.payments;

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
    ('Failed', 'Executing'),
    ('Failed', 'Cancelled')
  ) THEN
    RAISE EXCEPTION 'Invalid payment status transition for %: % -> %', NEW.id, OLD.status, NEW.status;
  END IF;

  INSERT INTO payment.payment_events (tenant_id, payment_id, from_status, to_status, actor, at)
  VALUES (NEW.tenant_id, NEW.id, OLD.status, NEW.status, 'system', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_transition_trigger
  AFTER INSERT OR UPDATE ON payment.payments
  FOR EACH ROW
  EXECUTE FUNCTION payment.enforce_and_log_transition();
