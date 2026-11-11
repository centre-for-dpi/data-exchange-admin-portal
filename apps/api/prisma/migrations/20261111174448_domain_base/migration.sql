-- CreateEnum
CREATE TYPE "entity_kind" AS ENUM ('national', 'territorial', 'autonomous', 'private_authorized');

-- CreateEnum
CREATE TYPE "entity_status" AS ENUM ('requested', 'under_review', 'active', 'rejected', 'suspended', 'offboarded');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('platform_admin', 'platform_reviewer', 'regulator', 'auditor');

-- CreateEnum
CREATE TYPE "entity_role" AS ENUM ('entity_admin', 'api_publisher', 'data_steward', 'app_developer', 'entity_viewer');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('invited', 'active', 'revoked');

-- CreateEnum
CREATE TYPE "purpose_source" AS ENUM ('config', 'operator');

-- CreateEnum
CREATE TYPE "classification" AS ENUM ('public', 'internal', 'personal', 'sensitive');

-- CreateEnum
CREATE TYPE "api_status" AS ENUM ('draft', 'published', 'deprecated', 'retired');

-- CreateEnum
CREATE TYPE "api_version_status" AS ENUM ('draft', 'in_review', 'changes_requested', 'approved_operator', 'approved_regulator', 'published', 'deprecated', 'retired');

-- CreateEnum
CREATE TYPE "upstream_type" AS ENUM ('node', 'xroad', 'direct');

-- CreateEnum
CREATE TYPE "app_environment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('client_secret', 'mtls_certificate');

-- CreateEnum
CREATE TYPE "credential_status" AS ENUM ('active', 'rotating', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('pending_provider', 'pending_regulator', 'approved', 'active', 'suspended', 'revoked', 'expired', 'rejected', 'withdrawn');

-- CreateEnum
CREATE TYPE "decision_kind" AS ENUM ('approved', 'rejected', 'info_requested', 'suspended', 'reactivated', 'revoked');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('pending', 'in_sync', 'drift', 'error');

-- CreateTable
CREATE TABLE "entity" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "legal_name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tax_id_type" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "kind" "entity_kind" NOT NULL,
    "sector" TEXT NOT NULL,
    "parent_entity_id" UUID,
    "status" "entity_status" NOT NULL DEFAULT 'requested',
    "contact_email" TEXT NOT NULL,
    "website" TEXT,
    "dpo_name" TEXT NOT NULL,
    "dpo_email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "keycloak_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "id_document_type" TEXT,
    "id_document_number_hash" TEXT,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_platform_role" (
    "user_id" UUID NOT NULL,
    "role" "platform_role" NOT NULL,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_platform_role_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "roles" "entity_role"[],
    "status" "membership_status" NOT NULL DEFAULT 'invited',
    "invited_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purpose" (
    "code" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB NOT NULL,
    "legal_reference" TEXT,
    "source" "purpose_source" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "purpose_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "api" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "tags" TEXT[],
    "classification" "classification" NOT NULL,
    "status" "api_status" NOT NULL DEFAULT 'draft',
    "owner_contact" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_version" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "api_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "status" "api_version_status" NOT NULL DEFAULT 'draft',
    "openapi_spec" JSONB NOT NULL,
    "openapi_sha256" TEXT NOT NULL,
    "lint_report" JSONB,
    "upstream_type" "upstream_type" NOT NULL,
    "upstream" JSONB NOT NULL,
    "base_path" TEXT NOT NULL,
    "exposed_fields" JSONB NOT NULL DEFAULT '[]',
    "legal_basis_text" TEXT,
    "legal_references" TEXT[],
    "sla" JSONB,
    "default_rate_limit" INTEGER NOT NULL DEFAULT 600,
    "published_at" TIMESTAMPTZ(3),
    "deprecated_at" TIMESTAMPTZ(3),
    "sunset_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "api_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_version_purpose" (
    "api_version_id" UUID NOT NULL,
    "purpose_code" TEXT NOT NULL,

    CONSTRAINT "api_version_purpose_pkey" PRIMARY KEY ("api_version_id","purpose_code")
);

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "environment" "app_environment" NOT NULL,
    "keycloak_client_id" TEXT NOT NULL,
    "status" "application_status" NOT NULL DEFAULT 'active',
    "technical_contact" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "application_id" UUID NOT NULL,
    "kind" "credential_kind" NOT NULL,
    "status" "credential_status" NOT NULL DEFAULT 'active',
    "fingerprint" TEXT,
    "serial" TEXT,
    "not_after" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "application_id" UUID NOT NULL,
    "api_version_id" UUID NOT NULL,
    "purpose_code" TEXT NOT NULL,
    "purpose_detail" TEXT NOT NULL,
    "legal_basis_text" TEXT NOT NULL,
    "legal_reference" TEXT,
    "agreement_document_id" UUID,
    "requested_operations" TEXT[],
    "approved_operations" TEXT[],
    "requested_rate_limit" INTEGER,
    "rate_limit_per_minute" INTEGER,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'pending_provider',
    "end_user_identification_required" BOOLEAN NOT NULL DEFAULT false,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_decision" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "subscription_id" UUID NOT NULL,
    "decision" "decision_kind" NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_by_entity_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "target" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "desired_hash" TEXT NOT NULL,
    "applied_hash" TEXT,
    "status" "sync_status" NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "applied_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("target")
);

-- CreateIndex
CREATE UNIQUE INDEX "entity_slug_key" ON "entity"("slug");

-- CreateIndex
CREATE INDEX "entity_status_idx" ON "entity"("status");

-- CreateIndex
CREATE UNIQUE INDEX "entity_tax_id_type_tax_id_key" ON "entity"("tax_id_type", "tax_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_keycloak_sub_key" ON "app_user"("keycloak_sub");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "membership_entity_id_idx" ON "membership"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_user_id_entity_id_key" ON "membership"("user_id", "entity_id");

-- CreateIndex
CREATE INDEX "api_status_classification_idx" ON "api"("status", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "api_entity_id_slug_key" ON "api"("entity_id", "slug");

-- CreateIndex
CREATE INDEX "api_version_status_idx" ON "api_version"("status");

-- CreateIndex
CREATE UNIQUE INDEX "api_version_api_id_major_minor_key" ON "api_version"("api_id", "major", "minor");

-- CreateIndex
CREATE UNIQUE INDEX "api_version_api_id_version_key" ON "api_version"("api_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "application_keycloak_client_id_key" ON "application"("keycloak_client_id");

-- CreateIndex
CREATE INDEX "application_entity_id_status_idx" ON "application"("entity_id", "status");

-- CreateIndex
CREATE INDEX "credential_application_id_status_idx" ON "credential"("application_id", "status");

-- CreateIndex
CREATE INDEX "subscription_api_version_id_status_idx" ON "subscription"("api_version_id", "status");

-- CreateIndex
CREATE INDEX "subscription_status_valid_until_idx" ON "subscription"("status", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_one_live_per_purpose" ON "subscription"("application_id", "api_version_id", "purpose_code") WHERE (status IN ('pending_provider', 'pending_regulator', 'approved', 'active', 'suspended'));

-- CreateIndex
CREATE INDEX "subscription_decision_subscription_id_created_at_idx" ON "subscription_decision"("subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_state_status_idx" ON "sync_state"("status");

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_parent_entity_id_fkey" FOREIGN KEY ("parent_entity_id") REFERENCES "entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_platform_role" ADD CONSTRAINT "user_platform_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api" ADD CONSTRAINT "api_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_version" ADD CONSTRAINT "api_version_api_id_fkey" FOREIGN KEY ("api_id") REFERENCES "api"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_version_purpose" ADD CONSTRAINT "api_version_purpose_api_version_id_fkey" FOREIGN KEY ("api_version_id") REFERENCES "api_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_version_purpose" ADD CONSTRAINT "api_version_purpose_purpose_code_fkey" FOREIGN KEY ("purpose_code") REFERENCES "purpose"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_api_version_id_fkey" FOREIGN KEY ("api_version_id") REFERENCES "api_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_purpose_code_fkey" FOREIGN KEY ("purpose_code") REFERENCES "purpose"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_decision" ADD CONSTRAINT "subscription_decision_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- "Nada se borra en el dominio" (SPEC.md §5): domain rows change status, they are never deleted.
-- The runtime role keeps DELETE only on technical tables (outbox, sync_state, pg-boss).
REVOKE DELETE, TRUNCATE ON
  "entity", "app_user", "user_platform_role", "membership", "purpose", "api", "api_version",
  "api_version_purpose", "application", "credential", "subscription", "subscription_decision"
FROM rid_app;
