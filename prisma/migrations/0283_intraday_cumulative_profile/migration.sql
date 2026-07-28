-- v1.34.0 — keep the intraday shape of a cumulative day before the fold
-- destroys it.
--
-- The nightly cumulative drain collapses per-sample Apple Health rows into one
-- daily total after the 36-hour grace window and hard-deletes the originals in
-- the same transaction. That left no substrate at all for a "typical by 21:00"
-- comparison on any day older than the grace window — today's curve was
-- derivable, every older day's was already gone. This table holds the
-- twenty-four running totals the drain now folds out of those rows first.
--
-- Sidecar only: the canonical `stats:` daily measurement stays the reading of
-- record. Nothing stored here is a measurement.
--
-- Additive — one table, three indexes, one foreign key. No ALTER on an
-- existing table, no DROP.

CREATE TABLE IF NOT EXISTS "intraday_cumulative_profiles" (
    "id"                TEXT               NOT NULL,
    "user_id"           TEXT               NOT NULL,
    "type"              "measurement_type" NOT NULL,
    -- Local calendar day in the user's timezone. VARCHAR so the trailing
    -- window read and the retention prune are both lexicographic range scans.
    "date_key"          VARCHAR(10)        NOT NULL,
    -- Twenty-four running totals; element h is the value accumulated through
    -- the END of local hour h, so the array is non-decreasing.
    "hourly_cumulative" DOUBLE PRECISION[],
    "day_total"         DOUBLE PRECISION   NOT NULL,
    -- Raw per-sample rows that backed the fold. A two-row day is not a shape.
    "sample_count"      INTEGER            NOT NULL,
    -- The zone the day was cut on. A later move leaves profiles on the old
    -- clock, and the reader drops them rather than compare mismatched hours.
    "timezone"          TEXT               NOT NULL,
    "created_at"        TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(3)     NOT NULL,

    CONSTRAINT "intraday_cumulative_profiles_pkey" PRIMARY KEY ("id")
);

-- The natural identity: one profile per user x type x local day. Makes the
-- drain's upsert idempotent under a re-run or an overlapping nightly tick.
CREATE UNIQUE INDEX IF NOT EXISTS "intraday_cumulative_profiles_user_type_date_key"
    ON "intraday_cumulative_profiles" ("user_id", "type", "date_key");

-- The trailing-window read the baseline issues: newest days first.
CREATE INDEX IF NOT EXISTS "intraday_cumulative_profiles_user_type_date_desc_idx"
    ON "intraday_cumulative_profiles" ("user_id", "type", "date_key" DESC);

-- The retention prune sweeps every account at once, so it needs an index that
-- does not lead with the user.
CREATE INDEX IF NOT EXISTS "intraday_cumulative_profiles_date_key_idx"
    ON "intraday_cumulative_profiles" ("date_key");

ALTER TABLE "intraday_cumulative_profiles"
    ADD CONSTRAINT "intraday_cumulative_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
