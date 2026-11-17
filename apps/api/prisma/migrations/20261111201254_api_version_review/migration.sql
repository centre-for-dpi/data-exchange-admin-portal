-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('approved', 'changes_requested');

-- AlterTable
ALTER TABLE "api_version" ADD COLUMN     "submitted_at" TIMESTAMPTZ(3),
ADD COLUMN     "submitted_by" UUID;

-- CreateTable
CREATE TABLE "api_version_review" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "api_version_id" UUID NOT NULL,
    "decision" "review_decision" NOT NULL,
    "reviewer_role" "platform_role" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_version_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_version_review_api_version_id_created_at_idx" ON "api_version_review"("api_version_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_version_review" ADD CONSTRAINT "api_version_review_api_version_id_fkey" FOREIGN KEY ("api_version_id") REFERENCES "api_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Review decisions are part of the record: append-only for the runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON "api_version_review" FROM den_app;
