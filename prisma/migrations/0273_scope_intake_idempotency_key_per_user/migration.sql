-- Scope the medication-intake idempotency key per user.
--
-- `medication_intake_events.idempotency_key` has carried a GLOBAL unique
-- index since 0001_init. The key is client-supplied, so a global unique
-- means one user's key can block another user's: the second user's write
-- is refused by the constraint and the dose is silently lost, and the
-- bulk route's unscoped replay probe resolves the key to the FIRST user's
-- row and hands its id back to the second user.
--
-- The correct grain is per user, matching every other client-supplied
-- identity on this table (`(user_id, external_id)`, migration 0239).
--
-- On existing data this is a RELAXATION: the old constraint is strictly
-- stronger than the new one — if no two rows anywhere share a key, then
-- no two rows of the SAME user share one either — so no row can violate
-- the new index and nothing needs reconciling. Step 1 below is a safety
-- net for a database whose global index was dropped by hand at some
-- point; against an intact schema it matches zero rows.
--
-- Step 1 never deletes or rewrites a dose. It only clears the dedup HINT
-- on the strictly later row of a colliding pair, keeping every intake
-- event, its timestamps, its attribution and its inventory stamp intact.
-- The cost is that one row loses replay protection it never really had.

-- 1. Safety net: break any pre-existing same-user key collision by
--    clearing the key on every row but the earliest of its group.
UPDATE "medication_intake_events" AS e
SET "idempotency_key" = NULL
WHERE e."idempotency_key" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "medication_intake_events" AS earlier
    WHERE earlier."user_id" = e."user_id"
      AND earlier."idempotency_key" = e."idempotency_key"
      AND (
        earlier."created_at" < e."created_at"
        OR (earlier."created_at" = e."created_at" AND earlier."id" < e."id")
      )
  );

-- 2. Create the per-user unique BEFORE dropping the global one, so a
--    failure here aborts the migration with the old protection intact.
CREATE UNIQUE INDEX "medication_intake_events_user_id_idempotency_key_key"
  ON "medication_intake_events" ("user_id", "idempotency_key");

-- 3. Retire the global unique.
DROP INDEX IF EXISTS "medication_intake_events_idempotency_key_key";
