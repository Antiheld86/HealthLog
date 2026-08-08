-- Per-reading source reference range on a lab result.
--
-- A lab report prints the window its own method and device produce, right
-- beside the value, and that window is what a physician evaluates against.
-- Until now the document reading pulled the value and dropped the range.
-- These three columns carry it: the derived numeric bounds where the printed
-- string yields them, plus the report's verbatim string, which is stored
-- whether or not it parsed. Nothing is backfilled — an existing row genuinely
-- has no source range on file and stays NULL.

ALTER TABLE "lab_results"
  ADD COLUMN "source_reference_low" DOUBLE PRECISION,
  ADD COLUMN "source_reference_high" DOUBLE PRECISION,
  ADD COLUMN "source_reference_text" TEXT;
