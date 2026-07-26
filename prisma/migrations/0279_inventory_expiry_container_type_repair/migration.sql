-- Restore supply containers that the in-use clock wrote off although they
-- never carried one, and drop the deadlines that would have written off the
-- rest of them over the following weeks.
--
-- Until this release the state machine started a 30-day post-opening clock
-- for every container as soon as `first_use_at` was set, including the
-- containers whose units stay individually sealed. Pressing the first tablet
-- out of a blister therefore condemned the rest of the pack a month later:
-- the row went EXPIRED, its units dropped out of the available pool, and the
-- supply card read "0 of 0 doses" beside a count of expired units.
--
-- Two things have to be undone. The rows already flipped need their state
-- back, and every clock-less container still carries a persisted `expires_at`
-- derived from that clock — including the ones whose deadline has not landed
-- yet. Leaving those would let the daily expire scan repeat the whole defect
-- on its own schedule.

-- (1) A clock-less container's only legitimate deadline is its printed
-- expiry, so that is what `expires_at` becomes. For the common row that is
-- NULL, which is precisely how it stays out of the daily expire scan. PEN and
-- AMPOULE are left alone: their post-opening clock is real, so the deadline
-- they carry is earned.
UPDATE "medication_inventory_items"
SET
  "expires_at" = "printed_expiry",
  "updated_at" = NOW()
WHERE "container_type" NOT IN ('PEN', 'AMPOULE')
  AND "expires_at" IS DISTINCT FROM "printed_expiry";

-- (2) The rows that already flipped. They are the ones that can ONLY have
-- reached EXPIRED through that clock:
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
--   * the state of every row that is not EXPIRED, and every other column.
--     No date is invented and no printed expiry is fabricated: a row that
--     recorded no expiry keeps recording none.
UPDATE "medication_inventory_items"
SET
  "state" = CASE
    WHEN "first_use_at" IS NOT NULL THEN 'IN_USE'::"medication_inventory_state"
    ELSE 'ACTIVE'::"medication_inventory_state"
  END,
  "updated_at" = NOW()
WHERE "state" = 'EXPIRED'
  AND "container_type" NOT IN ('PEN', 'AMPOULE')
  AND ("printed_expiry" IS NULL OR "printed_expiry" > NOW())
  AND "doses_remaining" > 0;
