-- M3-01: client certificates signed by step-ca for consumer applications.

-- AlterTable
ALTER TABLE "credential" ADD COLUMN     "certificate_pem" TEXT,
ADD COLUMN     "expiry_notice_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "not_before" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "credential_kind_status_not_after_idx" ON "credential"("kind", "status", "not_after");

-- CreateIndex
CREATE UNIQUE INDEX "credential_one_active_certificate" ON "credential"("application_id") WHERE ((kind = 'mtls_certificate'::credential_kind) AND (status = 'active'::credential_status));
