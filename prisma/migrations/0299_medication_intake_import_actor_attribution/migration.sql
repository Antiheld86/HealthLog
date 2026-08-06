-- Keep the record subject and the actor distinct for durable intake-import
-- work. Historical rows predate delegated imports, so their actor is the
-- record subject: the only truthful attribution available for those jobs.
ALTER TABLE "medication_intake_import_jobs"
  RENAME COLUMN "user_id" TO "record_user_id";

ALTER TABLE "medication_intake_import_jobs"
  RENAME CONSTRAINT "medication_intake_import_jobs_user_id_fkey"
  TO "medication_intake_import_jobs_record_user_id_fkey";

ALTER TABLE "medication_intake_import_jobs"
  ADD COLUMN "actor_user_id" TEXT;

UPDATE "medication_intake_import_jobs"
  SET "actor_user_id" = "record_user_id"
  WHERE "actor_user_id" IS NULL;

ALTER TABLE "medication_intake_import_jobs"
  ALTER COLUMN "actor_user_id" SET NOT NULL;

-- No actor foreign key: a deleted delegate must remain identifiable in the
-- record's durable job and audit trail, just like audit_logs.actor_user_id.

DROP INDEX "medication_intake_import_jobs_user_id_created_at_idx";
CREATE INDEX "medication_intake_import_jobs_record_user_id_created_at_idx"
  ON "medication_intake_import_jobs"("record_user_id", "created_at");
CREATE INDEX "medication_intake_import_jobs_actor_user_id_created_at_idx"
  ON "medication_intake_import_jobs"("actor_user_id", "created_at");
