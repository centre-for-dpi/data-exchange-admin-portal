-- Validity the consumer asked for; the data steward may only shorten it (SPEC.md §4.4). Rows that
-- already exist get it from their current validity window (at least one month).
ALTER TABLE "subscription" ADD COLUMN     "requested_validity_months" INTEGER;
UPDATE "subscription"
SET "requested_validity_months" = GREATEST(
  1,
  (EXTRACT(YEAR FROM age("valid_until", "valid_from")) * 12
    + EXTRACT(MONTH FROM age("valid_until", "valid_from")))::integer
);
ALTER TABLE "subscription" ALTER COLUMN "requested_validity_months" SET NOT NULL;

-- Subscription decisions are a record of who decided what (SPEC.md §3): the runtime role may only
-- insert them, like api_version_review. DELETE and TRUNCATE were already revoked in domain_base.
REVOKE UPDATE ON "subscription_decision" FROM rid_app;
