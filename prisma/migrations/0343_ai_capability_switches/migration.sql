-- The assistant switches stop AI work instead of hiding surfaces, and AI stops
-- being able to take data down with it.
--
-- 1. A new "Reading documents" switch covers the document vault's AI reads,
--    lab report scans and medication text extraction, which only the master
--    covered before. Default on, like every other switch.
ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "assistant_document_ai_enabled" BOOLEAN NOT NULL DEFAULT true;

-- 2. One operator Coach switch instead of two. Where the operator had turned
--    the Coach module off in module availability, the Coach switch takes that
--    answer; the availability key is then removed, since nothing reads it.
UPDATE "app_settings"
   SET "assistant_coach_enabled" = false
 WHERE jsonb_typeof("module_availability_json") = 'object'
   AND "module_availability_json" -> 'coach' = 'false'::jsonb;

UPDATE "app_settings"
   SET "module_availability_json" = "module_availability_json" - 'coach'
 WHERE jsonb_typeof("module_availability_json") = 'object'
   AND "module_availability_json" ? 'coach';

-- 3. "Hide Coach" means the Coach and nothing else from now on. It used to
--    stop the nightly briefing and status notes as well; that promise moves to
--    the AI analysis switch (the `insights` module), so everyone who hid the
--    Coach gets AI analysis switched off and keeps the privacy they chose.
--    `updated_at` moves so a settings form loaded before the upgrade cannot
--    write the old map back over this one.
UPDATE "users"
   SET "module_preferences_json" =
         CASE
           WHEN jsonb_typeof("module_preferences_json") = 'object'
             THEN "module_preferences_json" || '{"insights": false}'::jsonb
           ELSE '{"insights": false}'::jsonb
         END,
       "updated_at" = now()
 WHERE "disable_coach" = true;

-- 4. The Correlations switch gated statistics, not anything a model writes,
--    so it goes. Destructive by design: the setting is gone, and so is its
--    stored value.
ALTER TABLE "app_settings"
  DROP COLUMN IF EXISTS "assistant_correlations_enabled";
