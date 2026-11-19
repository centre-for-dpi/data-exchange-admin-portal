-- What a kit node serves against the published contract (P-02): the SHA-256 the node reports
-- for the service on a version's servicePath, compared with the version's. den_app reads and
-- writes the new table through the owner's default privileges.
-- CreateEnum
CREATE TYPE "node_contract_status" AS ENUM ('matches', 'differs', 'not_reported');

-- AlterTable
ALTER TABLE "api_version" ADD COLUMN     "openapi_sha256_variants" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "node_contract_check" (
    "api_version_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "status" "node_contract_status" NOT NULL,
    "service_name" TEXT,
    "expected_sha256" TEXT NOT NULL,
    "reported_sha256" TEXT,
    "since" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "node_contract_check_pkey" PRIMARY KEY ("api_version_id")
);

-- CreateIndex
CREATE INDEX "node_contract_check_node_id_idx" ON "node_contract_check"("node_id");

-- AddForeignKey
ALTER TABLE "node_contract_check" ADD CONSTRAINT "node_contract_check_api_version_id_fkey" FOREIGN KEY ("api_version_id") REFERENCES "api_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_contract_check" ADD CONSTRAINT "node_contract_check_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
