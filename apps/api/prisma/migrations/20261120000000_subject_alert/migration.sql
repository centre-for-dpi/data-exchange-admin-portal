-- Citizen notices of new consultations (ADR-0015, MT-06).
-- CreateTable
CREATE TABLE "subject_alert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_ref" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "classifications" "classification"[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subject_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_alert_subject_ref_client_id_key" ON "subject_alert"("subject_ref", "client_id");

