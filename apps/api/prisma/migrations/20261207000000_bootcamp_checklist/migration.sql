-- M4-07: bootcamp readiness checklist of an entity.
-- CreateEnum
CREATE TYPE "bootcamp_item" AS ENUM ('server', 'readonly_user', 'outbound_443', 'use_case');

-- CreateEnum
CREATE TYPE "bootcamp_item_status" AS ENUM ('pending', 'done');

-- CreateTable
CREATE TABLE "bootcamp_checklist_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "item" "bootcamp_item" NOT NULL,
    "status" "bootcamp_item_status" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootcamp_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bootcamp_checklist_item_entity_id_item_key" ON "bootcamp_checklist_item"("entity_id", "item");

-- AddForeignKey
ALTER TABLE "bootcamp_checklist_item" ADD CONSTRAINT "bootcamp_checklist_item_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- "Nada se borra en el dominio" (SPEC.md §5).
REVOKE DELETE, TRUNCATE ON "bootcamp_checklist_item" FROM den_app;
