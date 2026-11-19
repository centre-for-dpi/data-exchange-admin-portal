-- The transparency register no longer keeps the consumer's X-Request-Id (R-03, M-16): free text
-- the consumer chooses, stored for 60 months next to the data subject's pseudonym, which could be
-- the very document number the pseudonym stands for. It was never part of the evidence (the leaf
-- digest leaves it out, ARCHITECTURE.md §13) and nothing read it, so receipts and batches already
-- sealed still verify. Dropping a column is DDL: the insert-only trigger does not apply to it.
-- PostgreSQL marks the column dropped without rewriting the rows; the old values leave the disk
-- as the rows are rewritten (VACUUM FULL, or a dump and restore).
ALTER TABLE "subject_access_record" DROP COLUMN "request_id";
