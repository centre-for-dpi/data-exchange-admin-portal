-- R-06 (B-06, B-07): two partial unique indexes that were only enforced by service checks
-- (or, for renewals, not at all: the existing index leaves them out).
--
-- Safe on a populated database by failing clearly, not by guessing: if rows already break the
-- rule, the migration stops BEFORE changing anything and names them, so the operator decides
-- which one to close (retire the older version, withdraw the redundant renewal) and re-runs
-- `prisma migrate deploy`. Nothing is deleted or rewritten automatically.

DO $$
DECLARE
  offenders text;
BEGIN
  -- B-07: one non-retired version per (api, major).
  SELECT string_agg(format('api %s major %s: versions %s', api_id, major, versions), '; ')
    INTO offenders
  FROM (
    SELECT api_id, major, string_agg(version || ' (' || status::text || ')', ', ') AS versions
    FROM api_version
    WHERE status <> 'retired'
    GROUP BY api_id, major
    HAVING count(*) > 1
  ) d;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add api_version_one_live_per_major, retire the extra versions first: %', offenders;
  END IF;

  -- B-06: one open request (waiting for a decision) per (application, version, purpose),
  -- renewals included.
  SELECT string_agg(format('application %s version %s purpose %s: subscriptions %s',
                           application_id, api_version_id, purpose_code, ids), '; ')
    INTO offenders
  FROM (
    SELECT application_id, api_version_id, purpose_code, string_agg(id::text, ', ') AS ids
    FROM subscription
    WHERE status IN ('pending_provider', 'info_requested', 'pending_regulator')
    GROUP BY application_id, api_version_id, purpose_code
    HAVING count(*) > 1
  ) d;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add subscription_one_open_request_per_purpose, withdraw or reject the extra open requests first: %', offenders;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "api_version_one_live_per_major" ON "api_version"("api_id", "major") WHERE ((status <> 'retired'::api_version_status));

-- CreateIndex
CREATE UNIQUE INDEX "subscription_one_open_request_per_purpose" ON "subscription"("application_id", "api_version_id", "purpose_code") WHERE ((status = ANY (ARRAY['pending_provider'::subscription_status, 'info_requested'::subscription_status, 'pending_regulator'::subscription_status])));
