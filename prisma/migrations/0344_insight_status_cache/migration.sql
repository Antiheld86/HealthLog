-- Status notes move out of the audit log.
--
-- The per-metric status notes used to be appended to `audit_logs` as plaintext
-- JSON, one row per metric per day, next to the security trail. They now live
-- in their own table, encrypted at rest, one row per (user, metric, locale),
-- upserted in place.
--
-- 1. The new table.
-- CreateTable
CREATE TABLE "insight_status_caches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "text_encrypted" BYTEA,
    "items_encrypted" BYTEA,
    "input_hash" TEXT,
    "snapshot_hash" TEXT,
    "date_key" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3),
    "retry_at" TIMESTAMP(3),
    "negative_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_status_caches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insight_status_caches_user_id_metric_locale_key" ON "insight_status_caches"("user_id", "metric", "locale");

-- AddForeignKey
ALTER TABLE "insight_status_caches" ADD CONSTRAINT "insight_status_caches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The old rows go. DESTRUCTIVE by design: the notes are a regenerable
--    cache, nothing reads them from `audit_logs` any more, and leaving them
--    would keep plaintext health text in a table documented as holding none.
--    Nothing is copied across, because the old rows are plaintext and a
--    migration cannot encrypt; the first nightly run after the upgrade writes
--    every note again. Take a database backup before applying, as for 0339.
--    Matches exactly the cache keys `insights.<scope>-status.<locale>` (the
--    seven specialised scopes and the `metric:` / `derived-score:` /
--    `biomarker:` generic ones); no security-trail action has this shape.
DELETE FROM "audit_logs" WHERE "action" LIKE 'insights.%-status.%';
