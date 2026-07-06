-- V6 Epic 3 (Gate A3): tamper-evident audit hash chain.
--
-- Every operations.audit_events row commits to its predecessor. Per tenant: chain_seq is a
-- gapless 1..n sequence, prev_hash is the previous row's row_hash ('' for genesis), and
-- row_hash = sha256 over the UTF-8 bytes of
--   concat_ws(0x1F, tenant_id::text, id, actor, action, object, detail,
--             to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), prev_hash)
-- 0x1F (ASCII unit separator) avoids field-boundary ambiguity; every hashed column is
-- NOT NULL so concat_ws never silently drops a field. This expression is THE canonical
-- serialization — packages/shared/audit.mjs uses the identical SQL for inserts and
-- verification, so there is exactly one implementation to keep consistent.
--
-- Runtime appends serialize per tenant with pg_advisory_xact_lock(hashtext(tenant_id::text))
-- (see packages/shared/audit.mjs); this migration backfills existing rows ordered by
-- (at, id) within each tenant.
--
-- Known limitation: deleting the NEWEST rows of a tenant's chain (truncation) is not
-- detectable by chain verification alone; that requires external anchoring / WORM offload
-- (backlog 6.5). Interior deletions, edits, and relinking ARE detected. See
-- docs/RUNBOOKS.md "Audit chain break".

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE operations.audit_events
  ADD COLUMN IF NOT EXISTS chain_seq BIGINT,
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_hash TEXT;

DO $$
DECLARE
  r RECORD;
  prev TEXT := '';
  seq BIGINT := 0;
  cur_tenant UUID := NULL;
  new_hash TEXT;
BEGIN
  FOR r IN
    SELECT id, tenant_id FROM operations.audit_events ORDER BY tenant_id, at, id
  LOOP
    IF cur_tenant IS DISTINCT FROM r.tenant_id THEN
      cur_tenant := r.tenant_id;
      prev := '';
      seq := 0;
    END IF;
    seq := seq + 1;
    UPDATE operations.audit_events
       SET chain_seq = seq,
           prev_hash = prev,
           row_hash = encode(digest(convert_to(concat_ws(E'\x1f',
             tenant_id::text, id, actor, action, object, detail,
             to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             prev), 'UTF8'), 'sha256'), 'hex')
     WHERE id = r.id
     RETURNING row_hash INTO new_hash;
    prev := new_hash;
  END LOOP;
END $$;

ALTER TABLE operations.audit_events
  ALTER COLUMN chain_seq SET NOT NULL,
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN row_hash SET NOT NULL;

-- Gapless-per-tenant is enforced by verification; uniqueness is enforced here. The unique
-- index also serves the chain-head lookup (ORDER BY chain_seq DESC LIMIT 1).
ALTER TABLE operations.audit_events
  ADD CONSTRAINT audit_events_tenant_chain_seq_unique UNIQUE (tenant_id, chain_seq);
