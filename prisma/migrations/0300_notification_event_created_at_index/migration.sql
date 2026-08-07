-- v1.37.0 — notification event retention deletes globally by created_at.
-- The dedup lookup index starts with record_user_id, so it cannot serve this
-- trailing-edge cleanup predicate efficiently.
CREATE INDEX "notification_events_created_at_idx"
    ON "notification_events" ("created_at");
