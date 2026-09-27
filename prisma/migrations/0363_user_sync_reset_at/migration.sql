-- When an account's record was last replaced wholesale (a backup restore, or
-- the person deleting all their data). `/api/sync/changes` expires every
-- delta cursor issued before it, so a paired client re-initialises instead
-- of catching up from a position the restore invalidated. Nullable: an
-- account that was never restored or wiped has no reset to honour.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sync_reset_at" TIMESTAMP(3);
