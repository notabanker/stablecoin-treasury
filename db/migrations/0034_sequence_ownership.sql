-- Fix: svc_payment needs ownership of payment.payment_reference_seq for the
-- seed/reset path (ALTER SEQUENCE ... RESTART 1005).
ALTER SEQUENCE payment.payment_reference_seq OWNER TO svc_payment;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA payment TO svc_payment;
