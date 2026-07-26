-- v1.32.40 — indexes for the retention purges.
--
-- The nightly tombstone purge asks for `deleted_at IS NOT NULL AND deleted_at
-- < cutoff`, and the audit-log purge asks for `created_at < cutoff`. Neither
-- predicate had an index: every `deleted_at` index in the schema is PARTIAL on
-- `deleted_at IS NULL` (the live-rows predicate, the exact opposite of what a
-- purge needs), and every `audit_logs` index leads with `user_id` or `action`.
-- Both purges therefore planned a sequential scan and paid index maintenance
-- on every removed row. Each connection carries `statement_timeout=60000`
-- (`src/lib/db.ts`), so past a certain backlog the statement aborts, the
-- transaction rolls back, nothing is purged, and the next night runs the same
-- statement against the same rows. The purge that was meant to give deletion a
-- horizon could not close on the instances that needed it most.
--
-- The purges are batched as of the same release, so no single statement is on
-- the hook for a whole backlog; these indexes are what make each batch's
-- lookup cheap instead of a fresh sequential scan per batch.
--
-- The three tombstone indexes are PARTIAL on `deleted_at IS NOT NULL`, which
-- is the shape that matters here: on a healthy instance the index covers only
-- the tombstones, so it stays tiny and shrinks as the purge drains. Prisma
-- cannot express a partial predicate, so these stay raw-SQL-only — the same
-- convention as migrations 0087 / 0108 / 0243, noted at the model in
-- `schema.prisma`. `audit_logs(created_at)` is expressible and is declared on
-- the model.
--
-- Additive-only: every statement is `CREATE INDEX IF NOT EXISTS`, no table
-- rewrite, no data change. NON-CONCURRENT on purpose — Prisma Migrate wraps a
-- migration file in a transaction and `CREATE INDEX CONCURRENTLY` cannot run
-- in one; these build at boot, where docker-entrypoint runs `migrate deploy`
-- before the app serves traffic, so the build lock lands pre-traffic.

CREATE INDEX IF NOT EXISTS "measurements_tombstone_purge_idx"
  ON "measurements" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "mood_entries_tombstone_purge_idx"
  ON "mood_entries" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "medication_intake_events_tombstone_purge_idx"
  ON "medication_intake_events" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx"
  ON "audit_logs" ("created_at");
