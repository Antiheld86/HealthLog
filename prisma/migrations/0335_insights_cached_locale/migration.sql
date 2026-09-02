-- Tag the comprehensive-briefing cache with the language it was written in.
-- One slot per user; readers in another language treat a differing tag as an
-- empty cache. NULL on existing rows: treated as matching until the next write.
ALTER TABLE "users" ADD COLUMN "insights_cached_locale" TEXT;
