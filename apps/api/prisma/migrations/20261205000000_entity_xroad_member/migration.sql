-- M4-05: X-Road member of an entity, set by the operator (SPIKE S-5).

-- AlterTable
ALTER TABLE "entity" ADD COLUMN     "xroad_member_class" TEXT,
ADD COLUMN     "xroad_member_code" TEXT;

-- One X-Road member per entity of the network.
CREATE UNIQUE INDEX "entity_xroad_member_key" ON "entity"("xroad_member_class", "xroad_member_code");
