-- Hardens audit_event_extends_chain() (20261215000000), which is already applied: CREATE OR REPLACE.
--
-- 1. The function names its table with its schema and fixes its search_path, so a temporary
--    table or a schema earlier in the caller's search_path cannot make the check read another
--    table. pg_temp is listed last (it is otherwise searched first).
-- 2. The "not in the future" bound compares with clock_timestamp() (the wall clock at the INSERT),
--    not now() (the start of the transaction). The API appends a transaction's audit events just
--    before the commit (B-04), with occurred_at taken then, so a long transaction (offboarding an
--    entity, revoking certificates) would otherwise exceed the 60 s bound and fail to commit.
--    occurred_at is taken at append time, under the chain lock, so it never goes back along seq
--    because a transaction was long; the comparison with the previous event stays as it was.
--
-- The skew can be overridden with the setting den.audit_clock_skew_seconds by roles other than
-- the runtime role den_app (the integration tests use it to avoid sleeping for a minute); den_app
-- cannot loosen the check.

CREATE OR REPLACE FUNCTION audit_event_extends_chain() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  last_row RECORD;
  -- Same figure as CHAIN_CLOCK_SKEW_MS in apps/api/src/audit/chain.ts.
  skew interval := interval '60 seconds';
  override text;
BEGIN
  IF current_user <> 'den_app' THEN
    override := current_setting('den.audit_clock_skew_seconds', true);
    IF override IS NOT NULL AND override <> '' THEN
      skew := make_interval(secs => override::double precision);
    END IF;
  END IF;
  SELECT seq, hash, occurred_at INTO last_row
    FROM public.audit_event ORDER BY seq DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.seq <> last_row.seq + 1 THEN
      RAISE EXCEPTION 'audit_event must extend the chain: seq % does not follow %', NEW.seq, last_row.seq
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.prev_hash IS DISTINCT FROM last_row.hash THEN
      RAISE EXCEPTION 'audit_event must extend the chain: prev_hash is not the last hash'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.occurred_at < last_row.occurred_at - skew THEN
      RAISE EXCEPTION 'audit_event must extend the chain: occurred_at goes back'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.occurred_at > clock_timestamp() + skew THEN
    RAISE EXCEPTION 'audit_event must extend the chain: occurred_at is in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
