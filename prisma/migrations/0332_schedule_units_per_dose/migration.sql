-- #219 — per-schedule inventory units consumed per dose.
-- Additive, nullable, no backfill: every existing schedule row reads NULL and
-- the consume hook keeps inheriting the medication-level `units_per_dose`, so
-- behaviour is unchanged until a user sets a per-slot value. Same
-- Decimal(10,4) grain as `medications.units_per_dose`.
ALTER TABLE "medication_schedules" ADD COLUMN "units_per_dose" DECIMAL(10,4);
