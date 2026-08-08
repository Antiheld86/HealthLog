-- Visits: the encounter record and the address book it points at.
--
-- The whole of the previous "which doctor" model was one free-text column on a
-- reminder. A person typed the practice name once per reminder and could reach
-- nothing else that happened there. These five tables turn that string into a
-- record: a visit that happened or is booked, the practitioners it points at,
-- and three links to the documents, lab results and conditions it produced.
--
-- Additive only. No existing table is altered, nothing is backfilled, and the
-- new enum value on `reminder_origin` is not used by any statement here, so the
-- ADD VALUE is safe inside the migration transaction.

-- CreateEnum
CREATE TYPE "encounter_status" AS ENUM ('PLANNED', 'DONE', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "encounter_kind" AS ENUM ('ROUTINE', 'ACUTE', 'SPECIALIST', 'PREVENTIVE', 'EMERGENCY', 'HOSPITAL', 'THERAPY', 'OTHER');

-- AlterEnum
-- A planned visit mints one one-shot reminder on the existing engine rather
-- than starting a second one. ENCOUNTER rows are excluded from every Vorsorge
-- read surface; the published `origin` enum stays at two members.
ALTER TYPE "reminder_origin" ADD VALUE IF NOT EXISTS 'ENCOUNTER';

-- CreateTable
CREATE TABLE "encounters" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "status" "encounter_status" NOT NULL DEFAULT 'DONE',
    "kind" "encounter_kind" NOT NULL DEFAULT 'OTHER',
    "practitioner_id" TEXT,
    "reason_encrypted" BYTEA,
    "outcome_encrypted" BYTEA,
    "reminder_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioners" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "practice" TEXT,
    "location" TEXT,
    "phone" TEXT,
    "note_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "practitioners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_document_links" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_lab_links" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "lab_result_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_lab_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_condition_links" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_condition_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounters_user_id_deleted_at_occurred_at_idx" ON "encounters"("user_id", "deleted_at", "occurred_at");

-- CreateIndex
CREATE INDEX "encounters_user_id_status_occurred_at_idx" ON "encounters"("user_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "encounters_practitioner_id_idx" ON "encounters"("practitioner_id");

-- CreateIndex
CREATE INDEX "practitioners_user_id_deleted_at_name_idx" ON "practitioners"("user_id", "deleted_at", "name");

-- CreateIndex
CREATE INDEX "encounter_document_links_document_id_idx" ON "encounter_document_links"("document_id");

-- CreateIndex
CREATE INDEX "encounter_document_links_user_id_idx" ON "encounter_document_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_document_links_encounter_id_document_id_key" ON "encounter_document_links"("encounter_id", "document_id");

-- CreateIndex
CREATE INDEX "encounter_lab_links_lab_result_id_idx" ON "encounter_lab_links"("lab_result_id");

-- CreateIndex
CREATE INDEX "encounter_lab_links_user_id_idx" ON "encounter_lab_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_lab_links_encounter_id_lab_result_id_key" ON "encounter_lab_links"("encounter_id", "lab_result_id");

-- CreateIndex
CREATE INDEX "encounter_condition_links_episode_id_idx" ON "encounter_condition_links"("episode_id");

-- CreateIndex
CREATE INDEX "encounter_condition_links_user_id_idx" ON "encounter_condition_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_condition_links_encounter_id_episode_id_key" ON "encounter_condition_links"("encounter_id", "episode_id");

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "measurement_reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_document_links" ADD CONSTRAINT "encounter_document_links_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_document_links" ADD CONSTRAINT "encounter_document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_document_links" ADD CONSTRAINT "encounter_document_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_lab_links" ADD CONSTRAINT "encounter_lab_links_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_lab_links" ADD CONSTRAINT "encounter_lab_links_lab_result_id_fkey" FOREIGN KEY ("lab_result_id") REFERENCES "lab_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_lab_links" ADD CONSTRAINT "encounter_lab_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_condition_links" ADD CONSTRAINT "encounter_condition_links_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_condition_links" ADD CONSTRAINT "encounter_condition_links_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "illness_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_condition_links" ADD CONSTRAINT "encounter_condition_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
