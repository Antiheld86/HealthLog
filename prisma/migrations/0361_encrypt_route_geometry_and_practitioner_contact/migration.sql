-- Two more kinds of personal data were still stored readable: the GPS track of
-- an outdoor workout (whose first and last points are usually the person's
-- front door) and the phone number and address in the address book of doctors
-- and practices. All three move to AES-256-GCM at rest. The practitioner's
-- name and specialty stay readable, because the picker searches and sorts on
-- them.
--
-- SQL cannot encrypt, so this migration only adds the ciphertext columns and
-- the discovery indexes. The boot-time `free-text-encryption-backfill` job
-- encrypts the existing rows one at a time and nulls the readable values in
-- the same transaction. Readers prefer the ciphertext and fall back to the old
-- columns until the backfill has reached a row. The old columns are dropped in
-- a later release, once the backfill reports nothing left on every instance.
--
-- The encryption half is additive: no table rewrite, no data change. The
-- geometry loses its NOT NULL because every new track is written to the
-- ciphertext column and the readable one stays empty. The last block below is
-- the one data change in this file: it coarsens the environment module's
-- stored coordinates.

ALTER TABLE "workout_routes" ADD COLUMN "geometry_encrypted" BYTEA;
ALTER TABLE "workout_routes" ALTER COLUMN "geometry" DROP NOT NULL;

ALTER TABLE "practitioners" ADD COLUMN "location_encrypted" BYTEA;
ALTER TABLE "practitioners" ADD COLUMN "phone_encrypted" BYTEA;

-- Partial indexes on exactly the backfill's discovery predicates, so the boot
-- scan is index-only and shrinks to nothing as the backfill converges (the
-- 0357 precedent). A route row carries no user id; discovery joins it to its
-- workout, and the index keeps the route side of that join to the rows still
-- to seal. Non-concurrent: Prisma Migrate runs the file in a transaction, and
-- the build lands in the pre-traffic window at boot.
CREATE INDEX IF NOT EXISTS "workout_routes_geometry_backfill_idx"
  ON "workout_routes" ("workout_id")
  WHERE "geometry" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "practitioners_contact_backfill_idx"
  ON "practitioners" ("user_id")
  WHERE "phone" IS NOT NULL OR "location" IS NOT NULL;

-- The environment module's stored coordinates drop to 1 decimal, about 11 km
-- north-south and 7 km east-west at 50° N. They were rounded to 2 decimals
-- (about 1 km), which places a home in a neighbourhood rather than a town;
-- the weather reanalysis the module reads is gridded at 9 to 25 km, so the
-- coarser value costs no accuracy. The app rounds every new write the same
-- way. Idempotent: rounding an already-rounded value changes nothing.
UPDATE "users"
  SET "home_lat" = round("home_lat"::numeric, 1)::double precision,
      "home_lon" = round("home_lon"::numeric, 1)::double precision
  WHERE "home_lat" IS NOT NULL OR "home_lon" IS NOT NULL;

UPDATE "environment_travel_locations"
  SET "lat" = round("lat"::numeric, 1)::double precision,
      "lon" = round("lon"::numeric, 1)::double precision;

UPDATE "environment_contexts"
  SET "lat" = round("lat"::numeric, 1)::double precision,
      "lon" = round("lon"::numeric, 1)::double precision;
