-- Backups: which keys their content needs, and off-host copies that leave
-- with the account.
--
-- 1. A stored backup carries encrypted columns as the stored ciphertext, and
--    key rotation cannot reach inside a copy. Each copy now records the key
--    ids its content was written under, so the admin encryption view can say
--    which retired key is still needed and by how old a copy. Copies written
--    before this release are marked unrecorded rather than assumed clean.
ALTER TABLE "data_backups"
  ADD COLUMN "inner_key_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "inner_key_ids_recorded" BOOLEAN NOT NULL DEFAULT false;

-- 2. The same fact for the off-host bucket, per key rather than per object:
--    when the nightly run last wrote an object that needed each key.
CREATE TABLE "offhost_backup_key_use" (
  "key_id" TEXT NOT NULL,
  "first_written_at" TIMESTAMP(3) NOT NULL,
  "last_written_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offhost_backup_key_use_pkey" PRIMARY KEY ("key_id")
);

-- 3. Accounts whose off-host objects have to be deleted: written with the
--    account deletion or the data wipe, removed once the bucket holds nothing
--    for the account. No foreign key, because a deleted account's row is gone
--    by the time the job runs.
CREATE TABLE "offhost_purge_requests" (
  "id" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "last_failure" TEXT,
  CONSTRAINT "offhost_purge_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "offhost_purge_requests_requested_at_idx"
  ON "offhost_purge_requests"("requested_at");
