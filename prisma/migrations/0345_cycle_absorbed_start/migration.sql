-- A period start logged a few days before an existing start folds that start
-- into itself (the same period, entered out of order), soft-deleting it.
-- Nothing recorded which start was folded, so taking the earlier start back
-- could not bring the later one back: a mis-tapped "started" wiped the real
-- start and reopened the cycle before it. The folded row now names the start
-- that absorbed it, and removing that start restores it.
ALTER TABLE "menstrual_cycles"
  ADD COLUMN IF NOT EXISTS "absorbed_into_id" TEXT;
