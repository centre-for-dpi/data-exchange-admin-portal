-- M3-02: certificates of the gateway itself (TLS server), issued by step-ca.

-- CreateEnum
CREATE TYPE "gateway_certificate_purpose" AS ENUM ('server');

-- CreateTable
CREATE TABLE "gateway_certificate" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "purpose" "gateway_certificate_purpose" NOT NULL,
    "hosts" TEXT[],
    "certificate_pem" TEXT NOT NULL,
    "sealed_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "not_before" TIMESTAMPTZ(3) NOT NULL,
    "not_after" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gateway_certificate_purpose_not_after_idx" ON "gateway_certificate"("purpose", "not_after");
