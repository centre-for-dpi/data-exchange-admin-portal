-- M4-06: sandbox upstream of a version and its automatic validations at submission.

-- AlterTable
ALTER TABLE "api_version" ADD COLUMN     "sandbox_upstream" JSONB,
ADD COLUMN     "validation_report" JSONB;
