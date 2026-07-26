-- Integration sync ledger: date the failure streak, and name the leg that owns it.
--
-- `failing_since_at` is the start of the current unbroken failure streak,
-- whatever kind the classifier assigned. The per-kind buckets counted attempts
-- but nothing dated them, so a streak the classifier had called `transient`
-- could run for a thousand attempts without ever becoming anything: the park
-- test read `kind = 'persistent'` and the persistent anchor was only ever
-- stamped by a persistent failure.
--
-- `failing_leg` records which sync leg the error came from. The table is keyed
-- (user_id, integration) while Withings runs four legs on four crons and WHOOP
-- runs four resources on four more, so a sibling leg's success was clearing an
-- error it had not caused — several times an hour, which is why the strike
-- ladder never climbed.
ALTER TABLE "integration_statuses"
  ADD COLUMN "failing_since_at" TIMESTAMP(3),
  ADD COLUMN "failing_leg" TEXT;

-- Backfill for rows that are already failing. Without this a connection that
-- has been broken for weeks would restart its clock at the next attempt and
-- need another two days before it escalated. `last_success_at` is the honest
-- anchor where it exists (the streak began at most one cron tick after it);
-- rows that never succeeded fall back to the last attempt, then to creation.
-- `failing_leg` is left NULL: which leg broke is not recoverable from the row,
-- and NULL means "unattributed", under which any success still clears — the
-- pre-existing behaviour, applied only to the backfilled rows.
UPDATE "integration_statuses"
SET "failing_since_at" = COALESCE("last_success_at", "last_attempt_at", "created_at")
WHERE "state" IN ('error_transient', 'error_reauth', 'parked')
  AND "failing_since_at" IS NULL;
