-- Signing keys of the gateway's assertions to providers (ADR-0024, M6-10). den_app reads and
-- writes them through the owner's default privileges.
CREATE TABLE "gateway_signing_key" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kid" TEXT NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "sealed_private_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "compromised_at" TIMESTAMPTZ(3),

    CONSTRAINT "gateway_signing_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gateway_signing_key_kid_key" ON "gateway_signing_key"("kid");
