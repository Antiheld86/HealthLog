-- v1.37.0 — a monotonic counter for "how many times has this session's record
-- selector moved".
--
-- The problem it solves is not authorization; `acting_as_user_id` plus the
-- grant join already decides that. It is agreement. A browser holds several
-- tabs on one session, and a request that left a suspended tab before a switch
-- landed arrives after it — carrying an intent formed under the old record and
-- addressed to a server that has since moved. The request is perfectly
-- authorized and answers the wrong question. So every request that resolves a
-- record now asserts which context it believes it is in, and the server refuses
-- when that belief no longer matches the row.
--
-- The counter has to be the DATABASE's, not the application's, because the
-- application is not the only writer of the column it tracks. Three of the
-- five writers run no application code at all:
--
--   * `sessions_acting_as_user_id_fkey ON DELETE SET NULL` — deleting an owner
--     account nulls every delegate session pointing at it, by referential
--     action, with nothing to hook;
--   * raw `UPDATE sessions SET acting_as_user_id = NULL` in the end-to-end
--     fixtures;
--   * an operator at `psql`, and whatever writes this column next year.
--
-- An application-level increment would be a discipline those three break
-- silently, and a fence whose counter can silently fail to move is a fence that
-- passes stale requests. A row trigger cannot be forgotten.
--
-- BEFORE, not AFTER, and that timing is load-bearing: the trigger overwrites
-- whatever `record_epoch` the incoming statement supplied, so no writer can set
-- the epoch itself even by trying. The counter belongs to the database in the
-- strong sense.
--
-- `UPDATE OF "acting_as_user_id"` plus the `WHEN` clause keep the two writes
-- that touch a session on nearly every request off the trigger entirely — the
-- throttled `last_active_at` stamp and the sliding `expires_at` extension both
-- name other columns, and neither would satisfy the `IS DISTINCT FROM` test
-- even if it did.
--
-- Precedent for a trigger on this line: `0298_notification_delivery_identity`
-- ships `push_attempt_attribution_guard` the same way. A trigger is invisible
-- to Prisma's datamodel comparison, which 0298 already proved tolerable.

ALTER TABLE "sessions" ADD COLUMN "record_epoch" INTEGER NOT NULL DEFAULT 0;

-- A session already sitting inside somebody else's record is not a session
-- that has never left its own, and the fence's exemption for pre-existing
-- browser tabs is defined as epoch zero. Normalise before the trigger exists,
-- so that from the first request after deploy `record_epoch = 0` means exactly
-- "never pointed at another record, and not pointed at one now".
UPDATE "sessions" SET "record_epoch" = 1 WHERE "acting_as_user_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "sessions_bump_record_epoch"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW."record_epoch" := OLD."record_epoch" + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "sessions_record_epoch_bump"
    BEFORE UPDATE OF "acting_as_user_id" ON "sessions"
    FOR EACH ROW
    WHEN (OLD."acting_as_user_id" IS DISTINCT FROM NEW."acting_as_user_id")
    EXECUTE FUNCTION "sessions_bump_record_epoch"();
