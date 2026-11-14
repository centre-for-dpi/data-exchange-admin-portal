-- M2-11: operator decisions on active entities (suspension, reactivation, offboarding). Own
-- migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "entity_review_decision" ADD VALUE 'suspended';
ALTER TYPE "entity_review_decision" ADD VALUE 'reactivated';
ALTER TYPE "entity_review_decision" ADD VALUE 'offboarded';
