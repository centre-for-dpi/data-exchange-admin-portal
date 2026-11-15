-- M3-04: rotation window of credentials.

-- AlterTable
ALTER TABLE "credential" ADD COLUMN     "rotation_ends_at" TIMESTAMPTZ(3);

