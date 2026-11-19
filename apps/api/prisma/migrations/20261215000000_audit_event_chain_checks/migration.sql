-- B-01: the database refuses a new audit_event that does not extend the chain. The hash itself
-- cannot be checked here (it is SHA-256 over canonical JSON, computed by the API), but position,
-- link and time can, so a row planted with a position below the genesis, without a hash, off the
-- end of the chain or backdated is rejected on INSERT, not just reported by the verifier.
--
-- Safe on populated data: rows written before the chain (M1-11) have no hash and stay as they
-- are. The constraints are NOT VALID (they apply to new rows only, no scan of the table), and
-- the trigger only looks at the row being inserted and the one before it.

ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_seq_positive" CHECK ("seq" > 0) NOT VALID,
  ADD CONSTRAINT "audit_event_hash_present" CHECK ("hash" IS NOT NULL) NOT VALID;

CREATE FUNCTION audit_event_extends_chain() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  last_row RECORD;
  -- Same figure as CHAIN_CLOCK_SKEW_MS in apps/api/src/audit/chain.ts.
  skew CONSTANT interval := interval '60 seconds';
BEGIN
  SELECT seq, hash, occurred_at INTO last_row
    FROM audit_event ORDER BY seq DESC LIMIT 1;
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
  IF NEW.occurred_at > now() + skew THEN
    RAISE EXCEPTION 'audit_event must extend the chain: occurred_at is in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_extends_chain
  BEFORE INSERT ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION audit_event_extends_chain();
