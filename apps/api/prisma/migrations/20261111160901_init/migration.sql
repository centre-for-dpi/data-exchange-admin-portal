-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'system', 'application');

-- CreateTable
CREATE TABLE "audit_event" (
    "seq" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_entity_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "request_id" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "topic" TEXT NOT NULL,
    "aggregate" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_event_target_type_target_id_seq_idx" ON "audit_event"("target_type", "target_id", "seq");

-- CreateIndex
CREATE INDEX "audit_event_actor_entity_id_occurred_at_idx" ON "audit_event"("actor_entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_pending_idx" ON "outbox"("created_at");

-- Append-only audit log (CLAUDE.md rule 4, ARCHITECTURE.md §7).
-- 1) The runtime role can only INSERT and SELECT (default privileges granted it DML on creation).
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event" FROM rid_app;

-- 2) Defense in depth: nobody, including the owner, can modify or delete audit rows through
--    normal statements. Retention purges (SPEC.md §11) will need an explicit, audited procedure.
CREATE FUNCTION audit_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_is_append_only();
