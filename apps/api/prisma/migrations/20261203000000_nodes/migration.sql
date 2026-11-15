-- M4-01: nodes of the instant-APIs kit and their single-use enrollment tokens (SPEC.md §4.6).
-- CreateEnum
CREATE TYPE "node_status" AS ENUM ('enrollment_issued', 'enrolled', 'online', 'offline', 'decommissioned');

-- CreateEnum
CREATE TYPE "enrollment_token_status" AS ENUM ('active', 'used', 'revoked');

-- CreateTable
CREATE TABLE "node" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "node_status" NOT NULL DEFAULT 'enrollment_issued',
    "tunnel_address" TEXT,
    "wireguard_public_key" TEXT,
    "certificate_pem" TEXT,
    "certificate_serial" TEXT,
    "certificate_fingerprint" TEXT,
    "certificate_not_after" TIMESTAMPTZ(3),
    "kit_version" TEXT,
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "services" JSONB NOT NULL DEFAULT '[]',
    "enrolled_at" TIMESTAMPTZ(3),
    "decommissioned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_enrollment_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "node_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "enrollment_token_status" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_by" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_enrollment_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_tunnel_address_key" ON "node"("tunnel_address");

-- CreateIndex
CREATE UNIQUE INDEX "node_wireguard_public_key_key" ON "node"("wireguard_public_key");

-- CreateIndex
CREATE UNIQUE INDEX "node_certificate_fingerprint_key" ON "node"("certificate_fingerprint");

-- CreateIndex
CREATE INDEX "node_status_idx" ON "node"("status");

-- CreateIndex
CREATE UNIQUE INDEX "node_entity_id_name_key" ON "node"("entity_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "node_enrollment_token_token_hash_key" ON "node_enrollment_token"("token_hash");

-- CreateIndex
CREATE INDEX "node_enrollment_token_node_id_created_at_idx" ON "node_enrollment_token"("node_id", "created_at");

-- AddForeignKey
ALTER TABLE "node" ADD CONSTRAINT "node_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_enrollment_token" ADD CONSTRAINT "node_enrollment_token_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- "Nada se borra en el dominio" (SPEC.md §5): nodes are decommissioned, tokens revoked.
REVOKE DELETE, TRUNCATE ON "node", "node_enrollment_token" FROM rid_app;
