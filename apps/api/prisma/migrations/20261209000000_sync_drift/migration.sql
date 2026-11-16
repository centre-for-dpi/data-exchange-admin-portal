-- Drift the reconcilers found and repaired (M5-07): a target whose desired state had not
-- changed since it was applied, yet the system held something else.
ALTER TABLE "sync_state" ADD COLUMN "drift_detected_at" TIMESTAMPTZ(3);
ALTER TABLE "sync_state" ADD COLUMN "drift_count" INTEGER NOT NULL DEFAULT 0;
