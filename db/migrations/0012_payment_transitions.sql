-- Enforces the payment status transition graph at the database level and populates
-- payment.payment_events automatically, so no application code path -- including a future one
-- nobody remembers to update -- can silently move a payment through an invalid transition or
-- leave a gap in its history. The transition whitelist below matches every status-changing UPDATE
-- currently issued by services/payment-service/src/index.mjs; a transition not in this list
-- raises and rolls back the whole statement.
--
-- The formal multi-state vocabulary from the wider backlog (Draft/PendingApproval/.../
-- RepairRequired/Expired) is deliberately not adopted here: it would rename wire-format status
-- strings the frontend and existing tests depend on for no additional safety over enforcing the
-- transition graph on the strings already in use. That rename, if wanted, is a separate,
-- non-safety-critical follow-up.

CREATE OR REPLACE FUNCTION payment.enforce_and_log_transition() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Any starting status is legitimate here: fresh application creates start at 'Pending
    -- approval', 'Approved', or 'Blocked'; seed/demo data also bootstraps historical rows
    -- directly into 'Settled' or 'Blocked'. The transition graph below governs changes to an
    -- existing row, which is where an actual bug could silently corrupt state.
    INSERT INTO payment.payment_events (tenant_id, payment_id, from_status, to_status, actor, at)
    VALUES (NEW.tenant_id, NEW.id, NULL, NEW.status, 'system', now());
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    -- Not a transition (e.g. an approvals-count increment that doesn't yet cross the required
    -- threshold, or a provider_ref/chain_ref write). Nothing to validate or log.
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
    ('Executing', 'Failed')
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
