-- v1.38 — the expected value of a day, beside the day's own rating.
--
-- One row per account per local day, holding what the account's own past days
-- say a day like this one usually looks like. It is a second reading of a day,
-- never a correction of the first: the self-assessment on `mood_entries` is
-- stored exactly as the person set it and nothing here touches it. The
-- distance between the two is the whole point of having both.
--
-- Its own table rather than four more columns on `mood_entries`, and the
-- reason is a permission rather than a shape: a value the user must not be
-- able to overwrite has no business sitting in the row their own edit form
-- writes. One writer, one table.
--
-- Not carried in a disaster-recovery backup. Every value here is recomputable
-- from `mood_entries` + `mood_contexts` and the measurement tables, and the
-- nightly job rebuilds it. The verdict is written down in `DERIVED_MODELS`
-- (`src/lib/export/backup-plan.ts`) where the completeness guard reads it,
-- so a restore that comes back without these rows is doing what it was told.
--
-- No CHECK constraints on the ranges, matching `mood_contexts`: the bounds are
-- server-side, and a later change to a scale must not strand rows written
-- under the old one.

CREATE TABLE "mood_predictions" (
    "user_id"       TEXT NOT NULL,
    -- YYYY-MM-DD in the account's own zone, the same key `mood_entries.date`
    -- carries, so the two readings of one day join without a second timezone
    -- derivation.
    "date"          TEXT NOT NULL,

    -- The expected pleasantness (A1), 0-10, and the band around it. The band
    -- comes from the rolling-origin validation residuals, so it widens when
    -- the model is bad instead of staying confidently narrow.
    "predicted"     DOUBLE PRECISION NOT NULL,
    "ci_low"        DOUBLE PRECISION,
    "ci_high"       DOUBLE PRECISION,
    -- Complete days the fit was built from. Displayed wherever the value is.
    "n"             INTEGER NOT NULL,

    -- Bumped when the feature set or the fit changes, so a re-fit is legible
    -- in the stored rows rather than silently changing what they mean.
    "model_version" TEXT NOT NULL,
    -- JSON array of { feature, contribution }: the standardised coefficient
    -- times that day's standardised value. Stored so the explanation line is
    -- generated from what the model actually used.
    "features"      TEXT NOT NULL,
    "computed_at"   TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mood_predictions_pkey" PRIMARY KEY ("user_id", "date")
);

-- The account cascade every other user-scoped table here carries. The primary
-- key already leads with `user_id`, so the per-account sweep the job and the
-- wipe both run needs no second index.
ALTER TABLE "mood_predictions"
  ADD CONSTRAINT "mood_predictions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
