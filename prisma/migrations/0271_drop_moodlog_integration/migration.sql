-- v1.32.33 — retire the moodLog integration.
--
-- The bridge to the external moodLog service is gone: no pull cron, no
-- inbound webhook, no reverse push, no settings or admin surface. What this
-- migration removes is the integration's own state and nothing else.
--
-- DATA BOUNDARY — read before editing.
--
-- `mood_entries` is NOT touched. Mood is a first-class HealthLog module and
-- every row in that table is the user's own health record, including the rows
-- the bridge imported (they carry `source = 'MOODLOG'` and keep it, so the
-- mood list still labels them honestly). Nothing below names `mood_entries`,
-- and nothing below can reach it:
--
--   * The six dropped columns are plain scalars on `users` / `app_settings`.
--     None carries an index, a unique, a check or a foreign key (see
--     migration 0014, which added all six), so `DROP COLUMN` rewrites those
--     two tables' tuples and stops there. `DROP COLUMN` never cascades into
--     another table on its own, and there is no CASCADE keyword here.
--   * `mood_entries.user_id` references `users(id)`, not any dropped column.
--     Dropping a non-referenced column leaves that foreign key intact and
--     leaves every mood row addressable.
--   * The `integration_statuses` delete is scoped by `integration = 'moodlog'`
--     — sync-ledger bookkeeping for a provider that no longer exists. That
--     table holds no health values and nothing references it.
--
-- The pg-boss cleanup is guarded on the schema existing: the worker owns that
-- schema and creates it at boot, so a first-install database runs this
-- migration before `pgboss` exists. Without it, a live instance would keep an
-- hourly `moodlog-sync` schedule enqueuing work no handler drains.

-- Stop the retired cron and drain anything it already queued.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'pgboss' AND table_name = 'schedule'
  ) THEN
    DELETE FROM pgboss.schedule WHERE name = 'moodlog-sync';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'pgboss' AND table_name = 'job'
  ) THEN
    DELETE FROM pgboss.job WHERE name = 'moodlog-sync';
  END IF;
END
$$;

-- Sync-ledger row for the retired provider.
DELETE FROM "integration_statuses" WHERE "integration" = 'moodlog';

-- Per-user credentials and the enable flag.
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "mood_log_url_encrypted",
  DROP COLUMN IF EXISTS "mood_log_api_key_encrypted",
  DROP COLUMN IF EXISTS "mood_log_enabled",
  DROP COLUMN IF EXISTS "mood_log_last_synced_at",
  DROP COLUMN IF EXISTS "mood_log_webhook_secret";

-- Instance-wide kill switch for the retired integration.
ALTER TABLE "app_settings"
  DROP COLUMN IF EXISTS "mood_log_global";
