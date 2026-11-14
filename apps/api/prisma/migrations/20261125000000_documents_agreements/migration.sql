-- M2-07: the agreement document of a subscription and deletion of document bytes by legal order.

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "purge_order" TEXT,
ADD COLUMN     "purged_at" TIMESTAMPTZ(3),
ADD COLUMN     "purged_by" UUID;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_agreement_document_id_fkey" FOREIGN KEY ("agreement_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

