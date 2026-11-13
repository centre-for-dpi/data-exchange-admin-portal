-- CreateEnum
CREATE TYPE "subject_source" AS ENUM ('path', 'body');

-- CreateTable
CREATE TABLE "subject_access_record" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gateway_node" TEXT NOT NULL,
    "gateway_request_id" TEXT NOT NULL,
    "request_id" TEXT,
    "subject_ref" TEXT NOT NULL,
    "subject_source" "subject_source" NOT NULL,
    "provider_entity_id" UUID NOT NULL,
    "api_id" UUID NOT NULL,
    "api_version_id" UUID NOT NULL,
    "operation_id" TEXT NOT NULL,
    "exposed_fields" JSONB NOT NULL,
    "consumer_entity_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "purpose_code" TEXT NOT NULL,
    "end_user_hash" TEXT,
    "status" INTEGER NOT NULL,

    CONSTRAINT "subject_access_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_access_record_subject_ref_occurred_at_idx" ON "subject_access_record"("subject_ref", "occurred_at");

-- CreateIndex
CREATE INDEX "subject_access_record_occurred_at_idx" ON "subject_access_record"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "subject_access_record_gateway_node_gateway_request_id_key" ON "subject_access_record"("gateway_node", "gateway_request_id");

-- Insert-only (ADR-0015, MT-03), like audit_event:
-- 1) The runtime role can only INSERT and SELECT (default privileges granted it DML on creation).
REVOKE UPDATE, DELETE, TRUNCATE ON "subject_access_record" FROM rid_app;

-- 2) Nobody, including the owner, can update rows or delete them through normal statements. The
--    only way out is purge_subject_access_records(), and only for rows past retention.
CREATE FUNCTION subject_access_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('rid.subject_access_purge', true) = 'on'
     AND OLD.occurred_at < now() - interval '1 month' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'subject_access_record is insert-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER subject_access_record_no_update_delete
  BEFORE UPDATE OR DELETE ON "subject_access_record"
  FOR EACH ROW EXECUTE FUNCTION subject_access_record_guard();

CREATE TRIGGER subject_access_record_no_truncate
  BEFORE TRUNCATE ON "subject_access_record"
  FOR EACH STATEMENT EXECUTE FUNCTION subject_access_record_guard();

-- 3) Retention (retention.subjectAccessMonths): deletes the rows older than the given number of
--    months, at least one. Runs with the owner's rights; rid_app may only call it.
CREATE FUNCTION purge_subject_access_records(retention_months integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  deleted bigint;
BEGIN
  IF retention_months IS NULL OR retention_months < 1 THEN
    RAISE EXCEPTION 'retention must be at least one month (got %)', retention_months
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('rid.subject_access_purge', 'on', true);
  DELETE FROM subject_access_record
    WHERE occurred_at < now() - make_interval(months => retention_months);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('rid.subject_access_purge', 'off', true);
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_subject_access_records(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_subject_access_records(integer) TO rid_app;
