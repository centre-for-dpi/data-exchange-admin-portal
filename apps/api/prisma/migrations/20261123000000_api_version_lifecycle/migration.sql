-- M2-05: version lifecycle (ADR-0019): compatible revisions kept in api_version_revision,
-- who deprecated a version and when it was retired.

-- AlterTable
ALTER TABLE "api_version" ADD COLUMN     "deprecated_by" UUID,
ADD COLUMN     "retired_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "api_version_revision" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "api_version_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "openapi_spec" JSON NOT NULL,
    "openapi_sha256" TEXT NOT NULL,
    "replaced_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_version_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_version_revision_api_version_id_created_at_idx" ON "api_version_revision"("api_version_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_version_revision" ADD CONSTRAINT "api_version_revision_api_version_id_fkey" FOREIGN KEY ("api_version_id") REFERENCES "api_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

