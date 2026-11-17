-- M2-09: daily anchors of the audit chain, insert-only for everyone (the owner included).

-- CreateTable
CREATE TABLE "audit_anchor" (
    "day" TEXT NOT NULL,
    "last_seq" BIGINT NOT NULL,
    "last_hash" TEXT NOT NULL,
    "tsa_token" BYTEA NOT NULL,
    "tsa_gen_time" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_anchor_pkey" PRIMARY KEY ("day")
);


CREATE TRIGGER audit_anchor_insert_only BEFORE UPDATE OR DELETE ON "audit_anchor"
  FOR EACH ROW EXECUTE FUNCTION transparency_insert_only();
CREATE TRIGGER audit_anchor_no_truncate BEFORE TRUNCATE ON "audit_anchor"
  FOR EACH STATEMENT EXECUTE FUNCTION transparency_insert_only();
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_anchor" FROM den_app;
