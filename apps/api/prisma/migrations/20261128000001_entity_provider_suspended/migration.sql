-- M2-11: whether a suspended entity also stops serving its APIs.

-- AlterTable
ALTER TABLE "entity" ADD COLUMN     "provider_suspended" BOOLEAN NOT NULL DEFAULT false;

