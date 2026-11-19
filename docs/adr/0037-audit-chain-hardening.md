# ADR-0037 — Audit chain: checks in the table, events appended at the end of the transaction, verified anchors

- Status: Accepted (extends ADR-0032; does not replace it)
- Date: 2026-11-19
- Story: R-08 (`docs/BACKLOG.md`), findings B-01, B-02, B-03 and B-04 of the 2026-11 general review

## Context

- B-01. The chain verifier called "written before the chain" any row without a hash that preceded the first hashed one, with no check on its position, so a row inserted with `seq <= 0` passed; it did not look at `occurred_at`, so an event could be backdated; and the hash carries no key.
- B-02. The RFC 3161 token of each daily anchor was stored and never verified. An anchor dated in the future blocks the anchoring (a day is only anchored after the day of the latest anchor), silently.
- B-03. The sanitizer redacts any key containing `token`, so `tokenId` of the enrolment events disappeared from the log.
- B-04. `AuditService.record` took the chain's advisory lock when the event was recorded, and a transaction-level lock lasts until commit. A transaction that records many events over a long time (offboarding an entity, mass certificate revocation) held it for its whole duration, and every other writer in the network waited for it until its own transaction timed out.

## Decision

1. **The table refuses what does not extend the chain.** `CHECK (seq > 0)` and `CHECK (hash IS NOT NULL)` (both `NOT VALID`: rows before the chain have no hash) and a `BEFORE INSERT` trigger: `seq` = last + 1, `prev_hash` = last hash, `occurred_at` not more than 60 s before the previous event's nor more than 60 s after `now()`. The verifier checks the same, plus `seq <= 0`, ascending order among the events before the chain, and `occurred_at` along `seq` and against its clock, with the same tolerance (`CHAIN_CLOCK_SKEW_MS`) for the clocks of several instances. The hash stays unkeyed: a key held by the API would not protect against whoever owns the database and the API's configuration, and it would make the chain unverifiable by third parties. The limit is documented in ARCHITECTURE §7: the chain is tamper-evidence against someone who cannot recompute it; the anchor, sealed by a TSA the operator does not control and held by the regulators, is what protects against the database's owner.
2. **Events are appended at the end of the transaction.** `AuditService.record` snapshots and sanitizes the event and keeps it per transaction; `PrismaService.$transaction` appends all of them in one batch (one lock, one read of the last event, one `INSERT`, one timestamp) when the callback returns. A transaction that `PrismaService.$transaction` did not open writes at once, as before. `record` no longer returns the `seq`.
3. **Anchors are verified.** `/audit/verify` checks each token with `verifyTimestampToken` against the roots of `TsaClient` (`DEN_TSA_ROOTS_FILE` pinned, ADR-0032), that its time is the stored one, and that the anchor is not dated in the future (stamp more than 5 minutes ahead, or day beyond tomorrow; tomorrow is tolerated because the integration suite exercises the anchoring with a clock ahead and time zones differ at the edges). The anchoring refuses a stamp from the future. Without the roots, `anchors.timestampsChecked` is false and the result is not `valid` (fail closed). The e-mail to the regulators attaches the token. A metric (`den_audit_anchor_overdue_seconds`) and an alert (`DenAuditAnchorOverdue`, > 6 h for 15 min) report a finished day without its anchor.
4. **`*Id` keys that hold a UUID are not redacted.** The sanitizer keeps a key ending in `Id` or `_id` whose value is a UUID (`tokenId`, `credentialId`); any other value under such a key, and any key that is the secret itself, stays redacted.

## Alternatives considered

- Keyed hash (HMAC) — the key would live with the API, the database's owner and the API's operator are the same person in a small deployment, and third parties could no longer verify the chain. The anchor already covers that threat.
- Take the lock in a `SERIALIZABLE`-free "optimistic" way (retry on `seq` conflict) — the primary key already conflicts, but each retry would have to recompute hashes after the transaction's own work; a deferred batch is simpler and keeps `seq` without gaps.
- Raise the transaction timeouts — hides the contention and leaves the network blocked for the same time.
- Reject `day > today` for anchors — breaks the integration suite's use of a clock ahead; flagging beyond tomorrow catches what blocks the anchoring for more than a day.

## Consequences

- The chain lock is held for one `INSERT` however long the transaction is. The event of a change is no longer readable inside its transaction (nothing did so but the tests).
- A database with future-dated anchors from before this decision (only possible through the test clock) is flagged only beyond tomorrow.
- Pilot and demo databases: the migration applies as is; verification of existing rows is unchanged.
- Not covered: the stretch between the last anchor and now (up to a day) rests on the chain alone; a deployment that needs less has to anchor more often.
- Time of an event: `occurred_at` is taken when the batch is appended (under the chain lock, just before the commit), not when `record` is called, so it never goes back along `seq` because a transaction was long; the verifier's and the trigger's monotonicity checks need no allowance for transaction length. The trigger bounds the future against `clock_timestamp()` (the wall clock at the INSERT), not `now()` (the start of the transaction), so an offboarding or a mass revocation that runs for minutes still commits. The cost: an event's time is when its transaction ended, not when the change began.
- The trigger function names its table with the schema and fixes `search_path = pg_catalog, public, pg_temp` (migration `20261215000001`), so a temporary table or a schema earlier in the search path cannot make it read another table. Revoking `TEMP` from `den_app` was not done: pg-boss and Prisma may use temporary objects and the qualification already closes the hole. The setting `den.audit_clock_skew_seconds` shortens the skew for roles other than `den_app` (integration tests); `den_app` cannot loosen it.
