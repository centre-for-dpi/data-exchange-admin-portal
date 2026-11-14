-- M2-06: renewals (one live renewal per subscription, outside the one-live-per-purpose index) and the
-- renewal notice timestamp; info_requested counts as live.

-- DropIndex
DROP INDEX "subscription_one_live_per_purpose";

-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "renewal_notice_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "renews_subscription_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "subscription_one_live_per_purpose" ON "subscription"("application_id", "api_version_id", "purpose_code") WHERE ((status = ANY (ARRAY['pending_provider'::subscription_status, 'info_requested'::subscription_status, 'pending_regulator'::subscription_status, 'approved'::subscription_status, 'active'::subscription_status, 'suspended'::subscription_status])) AND (renews_subscription_id IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "subscription_one_live_renewal" ON "subscription"("renews_subscription_id") WHERE (status = ANY (ARRAY['pending_provider'::subscription_status, 'info_requested'::subscription_status, 'pending_regulator'::subscription_status, 'approved'::subscription_status, 'active'::subscription_status, 'suspended'::subscription_status]));

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_renews_subscription_id_fkey" FOREIGN KEY ("renews_subscription_id") REFERENCES "subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

