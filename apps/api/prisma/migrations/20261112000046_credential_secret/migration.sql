-- AlterTable
ALTER TABLE "credential" ADD COLUMN     "sealed_secret" TEXT,
ADD COLUMN     "secret_hash" TEXT;
