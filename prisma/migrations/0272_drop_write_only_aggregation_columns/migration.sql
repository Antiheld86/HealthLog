-- v1.32.35 — drop the two write-only aggregation columns on `measurements`.
--
-- Migration 0263 added three columns alongside the Apple Health `stats:*`
-- authority ladder. Only one of them was ever read back:
--
--   * `aggregation_provenance` is load-bearing and STAYS. The external
--     measurement reconciler selects it and refuses a lower-authority write
--     against a higher-authority canonical row, which is what keeps an
--     export.xml source-day estimate from clobbering a native HealthKit
--     statistic. The cumulative drain reads it too.
--   * `aggregation_contributor_count` and `aggregation_selected_source_hash`
--     are written and never read. Three call sites write them (the batch
--     ingest and the cumulative drain write explicit NULLs, the export.xml
--     import writes real values); nothing selects them, no raw SQL names
--     them, they reach no export, no backup, no API contract and no repair
--     path. Verified by a repo-wide search over every tracked file for both
--     the Prisma field names and the column names.
--
-- The import-time selection algorithm keeps its deterministic tiebreak: the
-- source hash it compares is an in-memory map key computed per flush, not a
-- value read back from this table. Only the persisted copies go.
--
-- DATA BOUNDARY — read before editing.
--
-- Both columns are plain nullable scalars added by 0263 with no index, no
-- unique, no check and no foreign key, so `DROP COLUMN` rewrites the tuples of
-- `measurements` and stops there. `DROP COLUMN` never cascades into another
-- table on its own, and there is no CASCADE keyword here. No measured value,
-- timestamp, unit, note or identity field is touched, and the documented
-- LEGACY_UNKNOWN repair path operates on `aggregation_provenance`, which
-- survives. In Postgres this is a catalog-only operation, so it is cheap even
-- on the largest table in the schema.

ALTER TABLE "measurements"
  DROP COLUMN IF EXISTS "aggregation_contributor_count",
  DROP COLUMN IF EXISTS "aggregation_selected_source_hash";
