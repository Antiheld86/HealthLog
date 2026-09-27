-- Index the two columns that point into `measurements`.
--
-- `personal_records.source_measurement_id` and `ecg_recordings.measurement_id`
-- are foreign keys into `measurements` with ON DELETE SET NULL, and neither
-- column had an index. Postgres enforces such a key with a trigger that runs
-- once per deleted measurement and looks the referencing rows up by that
-- column. Without an index every lookup is a sequential scan of the whole
-- referencing table, so deleting N readings costs N scans.
--
-- On a seeded account of 1.89 million readings with 300 personal records, the
-- restore's `DELETE FROM measurements WHERE user_id = $1` spent 1.5 s deleting
-- and 38 s in these two triggers. On a slower host that crossed the 60 s
-- statement timeout every connection carries (`src/lib/db.ts`), the restore
-- was cancelled in its clearing step and rolled back (#1031). The tombstone
-- purge and account deletion delete readings the same way and paid the same
-- cost per row.
--
-- Additive only: `CREATE INDEX IF NOT EXISTS`, no data change. Not
-- CONCURRENTLY, because Prisma Migrate runs a migration in a transaction; both
-- tables are small next to `measurements`, and `migrate deploy` runs at boot
-- before the app serves traffic.

CREATE INDEX IF NOT EXISTS "personal_records_source_measurement_id_idx"
  ON "personal_records" ("source_measurement_id");

CREATE INDEX IF NOT EXISTS "ecg_recordings_measurement_id_idx"
  ON "ecg_recordings" ("measurement_id");
