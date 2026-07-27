-- The integration ledger stops erasing itself, and the HealthKit trigger gets
-- somewhere to live.
--
-- 1. `failing_leg` → `failing_legs`
--
-- `failing_leg` was a single last-writer-wins slot. Withings runs four legs on
-- four crons and WHOOP four resources on four more, so two legs failing in
-- overlapping windows overwrote each other: the row remembered whichever failed
-- last, and a success from that leg then cleared an error the other one was
-- still causing. The slot becomes a set. A failure adds its leg, a success
-- removes its own, and the row's error state, per-kind buckets and streak
-- anchor clear only when the set is empty.
--
-- The array is ordered oldest-failure-first, so the last element is the leg that
-- owns whatever message `last_error` holds.
--
-- 2. `users`: the HealthKit sync trigger, persisted
--
-- The batch route has accepted an optional `syncTrigger` since v1.32.8 and put
-- it on the wide event, where no human reads it. Persisting it — plus the
-- instant of the most recent background-triggered batch — is what lets the
-- Apple Health card answer whether the phone is delivering on its own or only
-- when the app is open. Both nullable and additive.

ALTER TABLE "integration_statuses" ADD COLUMN "failing_legs" JSONB;

-- Carry every attributed leg forward as a one-element set. Rows whose
-- `failing_leg` is NULL become NULL too, not an empty array: NULL and `[]` both
-- read as "failing, but unattributed", and leaving them NULL keeps the backfill
-- to the rows that actually carry information.
UPDATE "integration_statuses"
SET "failing_legs" = jsonb_build_array("failing_leg")
WHERE "failing_leg" IS NOT NULL;

ALTER TABLE "integration_statuses" DROP COLUMN "failing_leg";

ALTER TABLE "users" ADD COLUMN "healthkit_last_sync_trigger" TEXT;
ALTER TABLE "users" ADD COLUMN "healthkit_last_background_sync_at" TIMESTAMP(3);
