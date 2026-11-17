-- Evidence of the transparency register (ADR-0016, MT-04): sealed batches (checkpoints), the
-- position of each record in its batch (leaves) and the TSA time-stamps. All insert-only.


-- CreateTable
CREATE TABLE "transparency_checkpoint" (
    "seq" INTEGER NOT NULL,
    "tree_size" INTEGER NOT NULL,
    "root" TEXT NOT NULL,
    "prev" TEXT,
    "hash" TEXT NOT NULL,
    "sealed_at" TIMESTAMPTZ(3) NOT NULL,
    "kid" TEXT NOT NULL,
    "jws" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transparency_checkpoint_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "transparency_leaf" (
    "record_id" UUID NOT NULL,
    "checkpoint_seq" INTEGER NOT NULL,
    "leaf_index" INTEGER NOT NULL,
    "leaf_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "transparency_leaf_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "transparency_timestamp" (
    "checkpoint_seq" INTEGER NOT NULL,
    "token" BYTEA NOT NULL,
    "gen_time" TIMESTAMPTZ(3) NOT NULL,
    "serial_number" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transparency_timestamp_pkey" PRIMARY KEY ("checkpoint_seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "transparency_checkpoint_hash_key" ON "transparency_checkpoint"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "transparency_leaf_checkpoint_seq_leaf_index_key" ON "transparency_leaf"("checkpoint_seq", "leaf_index");

-- AddForeignKey
ALTER TABLE "transparency_leaf" ADD CONSTRAINT "transparency_leaf_checkpoint_seq_fkey" FOREIGN KEY ("checkpoint_seq") REFERENCES "transparency_checkpoint"("seq") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transparency_timestamp" ADD CONSTRAINT "transparency_timestamp_checkpoint_seq_fkey" FOREIGN KEY ("checkpoint_seq") REFERENCES "transparency_checkpoint"("seq") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert-only, for everyone: the runtime role has no UPDATE, DELETE or TRUNCATE, and a trigger
-- refuses them to any role, owner included (changing evidence takes dropping the trigger, a DDL
-- change visible in the schema history).
REVOKE UPDATE, DELETE, TRUNCATE ON "transparency_checkpoint", "transparency_leaf", "transparency_timestamp" FROM den_app;

CREATE FUNCTION transparency_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER transparency_checkpoint_insert_only BEFORE UPDATE OR DELETE ON "transparency_checkpoint"
  FOR EACH ROW EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER transparency_checkpoint_no_truncate BEFORE TRUNCATE ON "transparency_checkpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER transparency_leaf_insert_only BEFORE UPDATE OR DELETE ON "transparency_leaf"
  FOR EACH ROW EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER transparency_leaf_no_truncate BEFORE TRUNCATE ON "transparency_leaf"
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER transparency_timestamp_insert_only BEFORE UPDATE OR DELETE ON "transparency_timestamp"
  FOR EACH ROW EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER transparency_timestamp_no_truncate BEFORE TRUNCATE ON "transparency_timestamp"
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_insert_only();
