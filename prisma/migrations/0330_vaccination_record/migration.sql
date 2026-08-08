-- Vaccinations: the immunization log and the page it was transcribed from.
--
-- Until now a scanned Impfpass could be filed as a document and nothing more —
-- no structured dose existed anywhere in the model. These two tables turn a
-- Pass line into a record: one row per administered dose, and the link that
-- keeps the scanned page beside it.
--
-- Additive, with one exception that is deliberate and small: the nullable
-- `vaccination_antigen` column on `measurement_reminders`. It is the match key
-- a logged dose uses to clear a booster reminder. No default, no backfill, no
-- read path outside the vaccination create route, and the published reminder
-- contract does not move.

-- CreateEnum
CREATE TYPE "vaccination_site" AS ENUM ('LEFT_ARM', 'RIGHT_ARM', 'LEFT_THIGH', 'RIGHT_THIGH', 'ORAL', 'NASAL', 'OTHER');

-- AlterTable
ALTER TABLE "measurement_reminders" ADD COLUMN     "vaccination_antigen" TEXT;

-- CreateTable
CREATE TABLE "vaccination_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "antigen_slug" TEXT,
    "vaccine_name" TEXT,
    "dose_number" INTEGER,
    "series_doses" INTEGER,
    "lot_number" TEXT,
    "site" "vaccination_site",
    "practitioner_id" TEXT,
    "encounter_id" TEXT,
    "reminder_id" TEXT,
    "note_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "vaccination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vaccination_document_links" (
    "id" TEXT NOT NULL,
    "vaccination_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vaccination_document_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vaccination_records_user_id_deleted_at_occurred_at_idx" ON "vaccination_records"("user_id", "deleted_at", "occurred_at");

-- CreateIndex
CREATE INDEX "vaccination_records_user_id_antigen_slug_occurred_at_idx" ON "vaccination_records"("user_id", "antigen_slug", "occurred_at");

-- CreateIndex
CREATE INDEX "vaccination_document_links_document_id_idx" ON "vaccination_document_links"("document_id");

-- CreateIndex
CREATE INDEX "vaccination_document_links_user_id_idx" ON "vaccination_document_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vaccination_document_links_vaccination_id_document_id_key" ON "vaccination_document_links"("vaccination_id", "document_id");

-- AddForeignKey
ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_records" ADD CONSTRAINT "vaccination_records_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "measurement_reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_document_links" ADD CONSTRAINT "vaccination_document_links_vaccination_id_fkey" FOREIGN KEY ("vaccination_id") REFERENCES "vaccination_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_document_links" ADD CONSTRAINT "vaccination_document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccination_document_links" ADD CONSTRAINT "vaccination_document_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
