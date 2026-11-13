-- Leaf format 2 of the transparency register (ADR-0016, MT-04): a leaf commits to the record's
-- id, its time and a digest of the record, so the id and time of a record purged by retention
-- stay bound to the signed root. Batches sealed before keep format 1 (no digest) and still
-- verify; the format is the "v" of each signed checkpoint.
ALTER TABLE "transparency_leaf" ADD COLUMN "record_digest" TEXT;
