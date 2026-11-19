-- Records waiting for the sealer (R-03, M-15). The sealer used to look for records without a leaf
-- every round with an anti-join over the whole register (tens of millions of rows at 60 months of
-- retention), with no index to answer it: past its 60 s timeout, nothing would be sealed again.
-- Now it reads this queue by (received_at, record_id) and removes what it seals, in the same
-- transaction as the leaves.

-- CreateTable
CREATE TABLE "transparency_pending" (
    "record_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transparency_pending_pkey" PRIMARY KEY ("record_id")
);

-- CreateIndex
CREATE INDEX "transparency_pending_received_at_record_id_idx" ON "transparency_pending"("received_at", "record_id");

-- AddForeignKey
ALTER TABLE "transparency_pending" ADD CONSTRAINT "transparency_pending_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "subject_access_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The runtime role adds (through the trigger below), reads and removes; it never rewrites.
REVOKE UPDATE, TRUNCATE ON "transparency_pending" FROM den_app;

-- 1) Every record inserted, whatever inserted it, is queued in the same statement. Statement
--    level, over the rows actually inserted: a duplicate skipped by ON CONFLICT is not queued.
CREATE FUNCTION transparency_pending_enqueue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.transparency_pending (record_id, received_at)
    SELECT id, received_at FROM inserted;
  RETURN NULL;
END;
$$;

CREATE TRIGGER subject_access_record_enqueue
  AFTER INSERT ON "subject_access_record"
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_pending_enqueue();

-- 2) A record leaves the queue only once it is sealed (it has a leaf), or with the record itself
--    when retention purges it (the cascade runs after the record is gone). Deleting a pending row
--    by hand would hide an unsealed record from the sealer: refused to everyone, owner included,
--    and so are UPDATE and TRUNCATE.
CREATE FUNCTION transparency_pending_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND (EXISTS (SELECT 1 FROM public.transparency_leaf l WHERE l.record_id = OLD.record_id)
          OR NOT EXISTS (SELECT 1 FROM public.subject_access_record r WHERE r.id = OLD.record_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'transparency_pending: a record leaves the queue only once sealed (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER transparency_pending_only_sealed
  BEFORE UPDATE OR DELETE ON "transparency_pending"
  FOR EACH ROW EXECUTE FUNCTION transparency_pending_guard();

CREATE TRIGGER transparency_pending_no_truncate
  BEFORE TRUNCATE ON "transparency_pending"
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_pending_guard();

-- 3) What is waiting now: the records without a leaf, once, here.
INSERT INTO "transparency_pending" ("record_id", "received_at")
  SELECT r.id, r.received_at FROM "subject_access_record" r
  WHERE NOT EXISTS (SELECT 1 FROM "transparency_leaf" l WHERE l.record_id = r.id)
  ON CONFLICT DO NOTHING;
