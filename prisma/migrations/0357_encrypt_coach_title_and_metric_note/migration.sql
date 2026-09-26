-- Two free-text columns were still stored readable: the title of a Coach
-- conversation (the first 80 characters of the opening message, or the name a
-- person gave the thread) and the note on a custom-metric reading. Both move
-- to AES-256-GCM at rest, in the same Bytes codec every other note uses.
--
-- SQL cannot encrypt, so this migration only adds the ciphertext columns and
-- the discovery indexes. The boot-time `free-text-encryption-backfill` job
-- encrypts the existing rows one at a time and nulls the readable value in the
-- same transaction. Readers prefer the ciphertext and fall back to the old
-- column until the backfill has reached a row. The old columns are dropped in
-- a later release, once the backfill reports nothing left on every instance.
--
-- Additive only: no table rewrite, no data change. The title loses its NOT
-- NULL because every new title is written to the ciphertext column and the
-- readable one stays empty.

ALTER TABLE "coach_conversations" ADD COLUMN "title_encrypted" BYTEA;
ALTER TABLE "coach_conversations" ALTER COLUMN "title" DROP NOT NULL;

ALTER TABLE "custom_metric_entries" ADD COLUMN "note_encrypted" BYTEA;

-- Partial indexes on exactly the backfill's discovery predicate, so the boot
-- scan is index-only and shrinks to nothing as the backfill converges (the
-- 0243 precedent). Non-concurrent: Prisma Migrate runs the file in a
-- transaction, and the build lands in the pre-traffic window at boot.
CREATE INDEX IF NOT EXISTS "coach_conversations_title_backfill_idx"
  ON "coach_conversations" ("user_id")
  WHERE "title" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "custom_metric_entries_note_backfill_idx"
  ON "custom_metric_entries" ("user_id")
  WHERE "note" IS NOT NULL;
