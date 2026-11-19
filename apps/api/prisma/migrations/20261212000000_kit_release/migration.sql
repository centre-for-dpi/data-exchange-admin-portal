-- Releases of the node kit the operator offers (P-03): version, link, size, SHA-256, the
-- signature once releases are signed, and the optional mirror of the bundle. den_app reads and
-- writes the table through the owner's default privileges; nothing is ever deleted.
-- CreateTable
CREATE TABLE "kit_release" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "signature_url" TEXT,
    "allowed_signers" TEXT,
    "made_current_at" TIMESTAMPTZ(3),
    "mirror_storage_key" TEXT,
    "mirrored_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kit_release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kit_release_version_key" ON "kit_release"("version");

-- CreateIndex
CREATE INDEX "kit_release_made_current_at_idx" ON "kit_release"("made_current_at");

REVOKE DELETE, TRUNCATE ON "kit_release" FROM den_app;
