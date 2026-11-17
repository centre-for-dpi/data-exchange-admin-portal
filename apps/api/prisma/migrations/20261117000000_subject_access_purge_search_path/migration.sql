-- Hardens the transparency purge against search_path shadowing (MT-03).
--
-- A SECURITY DEFINER function whose search_path does not list pg_temp searches the caller's
-- temporary schema first for relations: den_app could create a temporary table named
-- subject_access_retention with a floor of one month and shorten retention after all. The search
-- path now ends with pg_temp, and every object is schema-qualified.

CREATE OR REPLACE FUNCTION public.purge_subject_access_records(retention_months integer)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  floor_months integer;
  deleted bigint;
BEGIN
  SELECT r.min_months INTO STRICT floor_months FROM public.subject_access_retention r;
  IF retention_months IS NULL OR retention_months < floor_months THEN
    RAISE EXCEPTION 'retention must be at least % months (got %)', floor_months, retention_months
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('den.subject_access_purge', 'on', true);
  DELETE FROM public.subject_access_record
    WHERE occurred_at < pg_catalog.now() - pg_catalog.make_interval(months => retention_months);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM pg_catalog.set_config('den.subject_access_purge', 'off', true);
  INSERT INTO public.subject_access_purge_log (called_by, retention_months, min_months, deleted)
    VALUES (session_user, retention_months, floor_months, deleted);
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_subject_access_records(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_subject_access_records(integer) TO den_app;
