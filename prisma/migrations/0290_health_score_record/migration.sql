-- v1.35.0 — the health score as it was shown, one row per account per local day.
--
-- Nothing can rebuild this. The live computation always answers for today from
-- today's rows, so once the readings behind a past day have been corrected,
-- re-synced or simply grown, the number the person saw on that day is gone
-- unless it was written down. This table is the writing down.
--
-- Two properties are enforced here rather than left to the application:
--
--   * one row per account per local day, so a second computation on the same
--     day cannot mint a rival record of the same day, and the writer's
--     ON CONFLICT DO NOTHING has something to conflict against;
--   * a closed set of bands, so a row can never carry a band no surface knows
--     how to render.
--
-- There is deliberately no updated_at column. The row is written once and
-- never rewritten: a later computation under different readings, or under a
-- different configuration, leaves the earlier day exactly as it stood.

CREATE TABLE "health_score_records" (
    "id"                 TEXT NOT NULL,
    "user_id"            TEXT NOT NULL,
    "day_key"            VARCHAR(10) NOT NULL,
    "timezone"           TEXT NOT NULL,
    "composite"          INTEGER NOT NULL,
    "band"               VARCHAR(8) NOT NULL,
    "score_version"      INTEGER NOT NULL,
    "composition"        TEXT[] NOT NULL,
    "pillar_scores"      JSONB NOT NULL,
    "input_fingerprint"  VARCHAR(64) NOT NULL,
    "config_version"     INTEGER,
    "config_changed_at"  TIMESTAMPTZ(3),
    "computed_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_score_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "health_score_records_band_check"
        CHECK ("band" IN ('green', 'yellow', 'red')),
    CONSTRAINT "health_score_records_composite_range_check"
        CHECK ("composite" >= 0 AND "composite" <= 100),
    CONSTRAINT "health_score_records_day_key_check"
        CHECK ("day_key" ~ '^\d{4}-\d{2}-\d{2}$'),
    CONSTRAINT "health_score_records_composition_not_empty_check"
        CHECK (array_length("composition", 1) >= 1)
);

CREATE UNIQUE INDEX "health_score_records_user_id_day_key_key"
    ON "health_score_records" ("user_id", "day_key");

CREATE INDEX "health_score_records_user_id_day_key_desc_idx"
    ON "health_score_records" ("user_id", "day_key" DESC);

ALTER TABLE "health_score_records"
    ADD CONSTRAINT "health_score_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
