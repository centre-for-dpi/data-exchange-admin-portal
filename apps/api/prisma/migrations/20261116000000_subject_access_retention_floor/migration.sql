-- Transparency register retention, enforced by the database (MT-03, ARCHITECTURE.md §13).
--
-- The runtime role rid_app may call the purge, but must not be able to shorten retention: with
-- its credentials alone, purge_subject_access_records(1) would erase almost the whole register.
-- The minimum lives in a table only the schema owner writes; every purge leaves a row in a log
-- the runtime role can read but not change, whoever called it.

-- 1) Retention floor, one row. The operator sets it as the schema owner to the legal minimum of
--    the deployment (and keeps retention.subjectAccessMonths in the country config at or above it):
--    UPDATE subject_access_retention SET min_months = <n>;
CREATE TABLE "subject_access_retention" (
  "singleton" BOOLEAN NOT NULL DEFAULT true PRIMARY KEY CHECK ("singleton"),
  "min_months" INTEGER NOT NULL CHECK ("min_months" >= 1)
);
INSERT INTO "subject_access_retention" ("min_months") VALUES (60);
REVOKE ALL ON "subject_access_retention" FROM rid_app;

-- 2) Purge log: who purged, when, with what retention and how much. Append-only for everyone but
--    the owner; rid_app only reads it.
CREATE TABLE "subject_access_purge_log" (
  "id" UUID NOT NULL DEFAULT uuidv7() PRIMARY KEY,
  "purged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "called_by" TEXT NOT NULL,
  "retention_months" INTEGER NOT NULL,
  "min_months" INTEGER NOT NULL,
  "deleted" BIGINT NOT NULL
);
REVOKE ALL ON "subject_access_purge_log" FROM rid_app;
GRANT SELECT ON "subject_access_purge_log" TO rid_app;

-- 3) The purge refuses a retention under the floor and logs itself.
CREATE OR REPLACE FUNCTION purge_subject_access_records(retention_months integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  floor_months integer;
  deleted bigint;
BEGIN
  SELECT min_months INTO STRICT floor_months FROM subject_access_retention;
  IF retention_months IS NULL OR retention_months < floor_months THEN
    RAISE EXCEPTION 'retention must be at least % months (got %)', floor_months, retention_months
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('rid.subject_access_purge', 'on', true);
  DELETE FROM subject_access_record
    WHERE occurred_at < now() - make_interval(months => retention_months);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('rid.subject_access_purge', 'off', true);
  INSERT INTO subject_access_purge_log (called_by, retention_months, min_months, deleted)
    VALUES (session_user, retention_months, floor_months, deleted);
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_subject_access_records(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_subject_access_records(integer) TO rid_app;
