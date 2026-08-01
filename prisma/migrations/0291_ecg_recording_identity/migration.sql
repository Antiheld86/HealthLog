-- ECG recordings gain a second identity: what the recording IS, not what a
-- source calls it.
--
-- `(user_id, source, external_recording_id)` is the source's own id. The
-- `export.zip` importer derives it from a hash of the recording's content,
-- the live ingest sends the device's stable sample uuid, Withings sends its
-- `signalid`. One Apple Watch strip arriving through both doors therefore
-- carries two different ids and would land as two rows. This index closes
-- that: one device does not record two different strips at the same instant
-- at the same sampling rate.
--
-- The table already holds rows on every deployed instance, and two writers
-- have been creating them since v1.19.0, so the index cannot simply be
-- created — a pre-existing collision would abort the migration at boot. The
-- duplicates are resolved first, deterministically, and the rule is:
--
--   1. the row with the MOST SAMPLES wins. A stored strip beats a
--      verdict-only row with no signal to draw. This is the row a person
--      opens and sees their ECG in.
--   2. then the row LINKED to its paired event measurement. That link is
--      how the recording is reached from the rhythm-event timeline.
--   3. then the most RECENTLY WRITTEN row (`updated_at`), i.e. the freshest
--      version of the same recording.
--   4. then the lowest `id`, so the choice is total and the same on every
--      instance rather than left to whatever order the planner returns.
--
-- Before the losers go, their event link is salvaged onto the keeper when the
-- keeper has none, so resolving a duplicate never costs the recording its
-- place in the event timeline.

-- Salvage the event link.
WITH ranked AS (
  SELECT
    id,
    user_id,
    source,
    recorded_at,
    sampling_frequency,
    measurement_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, source, recorded_at, sampling_frequency
      ORDER BY
        sample_count DESC,
        (measurement_id IS NOT NULL) DESC,
        updated_at DESC,
        id ASC
    ) AS rn
  FROM "ecg_recordings"
),
donors AS (
  SELECT keeper.id AS keeper_id, MIN(loser.measurement_id) AS measurement_id
  FROM ranked AS keeper
  JOIN ranked AS loser
    ON loser.user_id = keeper.user_id
   AND loser.source = keeper.source
   AND loser.recorded_at = keeper.recorded_at
   AND loser.sampling_frequency = keeper.sampling_frequency
   AND loser.rn > 1
  WHERE keeper.rn = 1
    AND keeper.measurement_id IS NULL
    AND loser.measurement_id IS NOT NULL
  GROUP BY keeper.id
)
UPDATE "ecg_recordings" AS e
SET "measurement_id" = donors.measurement_id
FROM donors
WHERE e."id" = donors.keeper_id;

-- Drop the resolved duplicates.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, source, recorded_at, sampling_frequency
      ORDER BY
        sample_count DESC,
        (measurement_id IS NOT NULL) DESC,
        updated_at DESC,
        id ASC
    ) AS rn
  FROM "ecg_recordings"
)
DELETE FROM "ecg_recordings" AS e
USING ranked
WHERE e."id" = ranked.id
  AND ranked.rn > 1;

-- The guarantee itself.
CREATE UNIQUE INDEX "ecg_recordings_user_source_recorded_at_freq_key"
  ON "ecg_recordings" ("user_id", "source", "recorded_at", "sampling_frequency");
