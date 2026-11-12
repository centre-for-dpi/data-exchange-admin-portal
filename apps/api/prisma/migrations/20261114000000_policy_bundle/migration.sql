-- CreateTable
CREATE TABLE "policy_bundle" (
    "revision" TEXT NOT NULL,
    "subscription_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "policy_bundle_pkey" PRIMARY KEY ("revision")
);
-- CreateIndex
CREATE INDEX "policy_bundle_created_at_idx" ON "policy_bundle"("created_at");
