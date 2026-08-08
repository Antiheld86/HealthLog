-- Research Mode is gone: the estimated GLP-1 drug-level curve is part of the
-- medication page for everyone, so the opt-in flag and the two acknowledgment
-- stamps it kept have no reader and no writer left. The endpoint, the
-- acknowledgment dialog and the Settings switch went with them.
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "research_mode_enabled",
  DROP COLUMN IF EXISTS "research_mode_acknowledged_at",
  DROP COLUMN IF EXISTS "research_mode_acknowledged_version";
