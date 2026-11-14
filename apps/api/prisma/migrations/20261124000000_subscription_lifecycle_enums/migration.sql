-- M2-06: new subscription status and decision kinds. Added in a migration of their own: a new
-- enum value cannot be used in the same transaction that adds it.
ALTER TYPE "subscription_status" ADD VALUE 'info_requested' AFTER 'pending_provider';
ALTER TYPE "decision_kind" ADD VALUE 'info_provided';
ALTER TYPE "decision_kind" ADD VALUE 'withdrawn';
