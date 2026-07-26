-- Restore supply containers that the in-use clock wrote off although they
-- never carried one.
--
-- Until this release the state machine started a 30-day post-opening clock
-- for every container as soon as `first_use_at` was set, including the
-- containers whose units stay individually sealed. Pressing the first tablet
-- out of a blister therefore condemned the rest of the pack a month later:
-- the row went EXPIRED, its units dropped out of the available pool, and the
-- supply card read "0 of 0 doses" beside a count of expired units.
--
-- The rows to restore are the ones that can ONLY have reached EXPIRED through
-- that clock:
--   * `container_type` is one of the kinds that has no post-opening clock
--     (everything except PEN and AMPOULE — see IN_USE_CLOCK_CONTAINER_TYPES
--     in src/lib/medications/inventory/state-machine.ts),
--   * the printed expiry is absent or still ahead of now, so the printed
--     label cannot be what expired the row,
--   * units are left, so USED_UP is not the answer either.
--
-- Nothing else can have set EXPIRED: the API cannot write that state
-- directly, the daily cron only flips rows whose `expires_at` has lapsed,
-- and the consumption hook derives the state from the same two clocks.
--
-- Deliberately untouched:
--   * PEN and AMPOULE rows — their clock is real and their EXPIRED is earned;
--   * any row whose printed expiry has genuinely lapsed, whatever its kind;
--   * rows with no units left (their state is a USED_UP question, not this
--     one);
--   * every other column. No date is invented and no printed expiry is
--     fabricated: a row that recorded no expiry keeps recording none, which
--     is why `expires_at` is set from `printed_expiry` rather than computed.
UPDATE "medication_inventory_items"
SET
  "state" = CASE
    WHEN "first_use_at" IS NOT NULL THEN 'IN_USE'::"medication_inventory_state"
    ELSE 'ACTIVE'::"medication_inventory_state"
  END,
  -- The only deadline a clock-less container can carry is its printed one.
  "expires_at" = "printed_expiry",
  "updated_at" = NOW()
WHERE "state" = 'EXPIRED'
  AND "container_type" NOT IN ('PEN', 'AMPOULE')
  AND ("printed_expiry" IS NULL OR "printed_expiry" > NOW())
  AND "doses_remaining" > 0;
