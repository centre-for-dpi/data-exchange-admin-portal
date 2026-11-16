-- Manual steps a use case avoids (SPEC.md §8, M5-04): captured with the bootcamp's use case.
ALTER TABLE "bootcamp_checklist_item" ADD COLUMN "manual_steps_avoided" INTEGER;
ALTER TABLE "bootcamp_checklist_item" ADD CONSTRAINT "bootcamp_manual_steps_range"
  CHECK ("manual_steps_avoided" IS NULL OR ("manual_steps_avoided" BETWEEN 0 AND 10000));
