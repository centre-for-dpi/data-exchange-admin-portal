-- M4-02: what the control channel of kit nodes keeps (enrollment, heartbeat, renewal).

-- AlterTable
ALTER TABLE "node" ADD COLUMN     "health" JSONB,
ADD COLUMN     "previous_certificate_fingerprint" TEXT,
ADD COLUMN     "previous_certificate_until" TIMESTAMPTZ(3),
ADD COLUMN     "service_port" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "node_previous_certificate_fingerprint_key" ON "node"("previous_certificate_fingerprint");
