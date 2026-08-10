-- Emergency ("Notfalldaten") facts on the health profile.
--
-- Additive only. No table is dropped or restructured: three new enum types and
-- six new nullable columns fold into the existing `user_health_profiles` row,
-- one row per user. The three enums are plaintext closed sets read directly by
-- the doctor-report emergency page (the same shape `User.gender` uses); the
-- three BYTEA columns hold AES-256-GCM ciphertext, fail-closed on read like
-- every other `*_encrypted` column. Every column is nullable, so an account
-- that never fills in an emergency profile carries six NULLs and nothing
-- surfaces.

-- CreateEnum
CREATE TYPE "emergency_blood_type" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "organ_donor_status" AS ENUM ('YES', 'NO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "advance_directive_status" AS ENUM ('EXISTS', 'NONE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "user_health_profiles"
    ADD COLUMN "emergency_blood_type" "emergency_blood_type",
    ADD COLUMN "organ_donor_status" "organ_donor_status",
    ADD COLUMN "advance_directive_status" "advance_directive_status",
    ADD COLUMN "emergency_contacts_encrypted" BYTEA,
    ADD COLUMN "emergency_implants_encrypted" BYTEA,
    ADD COLUMN "emergency_note_encrypted" BYTEA;
