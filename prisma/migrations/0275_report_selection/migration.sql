-- The owner's saved report selection: the leaf-id inclusion list plus the
-- format / range / charts choices the export panel restores.
ALTER TABLE "users" ADD COLUMN "report_selection_json" JSONB;

-- Retire the orphaned flat prefs column. No code outside its own route ever
-- read it — the route's docblock claimed the aggregator consulted it, which
-- was not true — and the route is removed in the same release.
ALTER TABLE "users" DROP COLUMN "doctor_report_prefs_json";

-- Retire the share-link FHIR scope columns. The face they described was never
-- built and their controls are gone. An inert column with a plausible name is
-- precisely what a later contributor rewires by mistake.
ALTER TABLE "clinician_share_links" DROP COLUMN "resource_types";
ALTER TABLE "clinician_share_links" DROP COLUMN "allow_fhir_api";

-- Revoke every live RECORD share link minted before the selection model. Their
-- frozen scope is `{}` or a flat prefs blob, both of which resolved to
-- "everything except mood and cycle" — a scope nobody chose. Downgrading them
-- to something narrower would still be a scope nobody chose, so they close and
-- the owner re-mints from the sharing list, which shows each one in a
-- pick-again state with its label, window and expiry preserved.
--
-- Documents-only shares are untouched: they carry an explicit empty report
-- scope and serve no health metric.
UPDATE "clinician_share_links"
   SET "revoked_at" = NOW()
 WHERE "revoked_at" IS NULL
   AND "document_only" = false
   AND "expires_at" > NOW();
