-- M2-01: entity onboarding requests, designees, operator reviews, documents and invitations
-- (SPEC.md §4.1, ADR-0018). Slug and tax id stay unique among entities that are not rejected.

-- CreateEnum
CREATE TYPE "designee_role" AS ENUM ('data_steward', 'technical_lead');

-- CreateEnum
CREATE TYPE "entity_review_decision" AS ENUM ('approved', 'changes_requested', 'rejected');

-- CreateEnum
CREATE TYPE "document_kind" AS ENUM ('designation', 'agreement', 'annex', 'other');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('pending', 'accepted', 'declined', 'revoked');

-- DropIndex
DROP INDEX "entity_slug_key";

-- DropIndex
DROP INDEX "entity_tax_id_type_tax_id_key";

-- AlterTable
ALTER TABLE "entity" ADD COLUMN     "applicant_id" UUID,
ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "designation_document_id" UUID,
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "entity_designee" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "role" "designee_role" NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "entity_designee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_review" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "decision" "entity_review_decision" NOT NULL,
    "reviewer_role" "platform_role" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_entity_id" UUID NOT NULL,
    "kind" "document_kind" NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT,
    "roles" "entity_role"[],
    "status" "invitation_status" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "invited_by" TEXT NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "responded_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entity_designee_entity_id_role_key" ON "entity_designee"("entity_id", "role");

-- CreateIndex
CREATE INDEX "entity_review_entity_id_created_at_idx" ON "entity_review"("entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_storage_key_key" ON "document"("storage_key");

-- CreateIndex
CREATE INDEX "document_owner_entity_id_idx" ON "document"("owner_entity_id");

-- CreateIndex
CREATE INDEX "invitation_email_status_idx" ON "invitation"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_one_pending" ON "invitation"("entity_id", "email") WHERE (status = 'pending'::invitation_status);

-- CreateIndex
CREATE UNIQUE INDEX "entity_designation_document_id_key" ON "entity"("designation_document_id");

-- CreateIndex
CREATE INDEX "entity_applicant_id_idx" ON "entity"("applicant_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_slug_live" ON "entity"("slug") WHERE (status <> 'rejected'::entity_status);

-- CreateIndex
CREATE UNIQUE INDEX "entity_tax_id_live" ON "entity"("tax_id_type", "tax_id") WHERE (status <> 'rejected'::entity_status);

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_designation_document_id_fkey" FOREIGN KEY ("designation_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_designee" ADD CONSTRAINT "entity_designee_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_review" ADD CONSTRAINT "entity_review_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_owner_entity_id_fkey" FOREIGN KEY ("owner_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

