-- Refs #223 + iOS #68 — Vorsorge snooze/skip + the completion ledger.
-- All additive; every existing reminder keeps its exact behaviour.

-- Snooze cursor: non-NULL and in the future = "pushed back until this
-- instant". The snooze write sets next_due_at to the SAME instant, so every
-- due-state consumer moves with it; expiry is the clock passing the value.
ALTER TABLE "measurement_reminders" ADD COLUMN "snoozed_until" TIMESTAMP(3);

-- Last honest skip. A skip re-anchors next_due_at at the skip instant but
-- never moves last_satisfied_at — done and skipped stay distinguishable.
ALTER TABLE "measurement_reminders" ADD COLUMN "last_skipped_at" TIMESTAMP(3);

-- Lifetime skip counter ("skipped N times").
ALTER TABLE "measurement_reminders" ADD COLUMN "skip_count" INTEGER NOT NULL DEFAULT 0;

-- The completion ledger (iOS #68). The engine is single-cursor, so before
-- this table each satisfy overwrote the last and history was unrecoverable.
-- Append-only: one row per satisfy / skip, written by the one satisfy
-- primitive and the skip route. History starts with this release — the
-- cursor holds nothing to backfill from.
CREATE TYPE "measurement_reminder_event_kind" AS ENUM ('SATISFIED', 'SKIPPED');

CREATE TABLE "measurement_reminder_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reminder_id" TEXT NOT NULL,
    "kind" "measurement_reminder_event_kind" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "on_time" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_reminder_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "measurement_reminder_events_reminder_id_occurred_at_idx"
    ON "measurement_reminder_events"("reminder_id", "occurred_at");

CREATE INDEX "measurement_reminder_events_user_id_idx"
    ON "measurement_reminder_events"("user_id");

ALTER TABLE "measurement_reminder_events"
    ADD CONSTRAINT "measurement_reminder_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "measurement_reminder_events"
    ADD CONSTRAINT "measurement_reminder_events_reminder_id_fkey"
    FOREIGN KEY ("reminder_id") REFERENCES "measurement_reminders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom-metric entries gain the soft-delete tombstone every peer entry
-- surface already has (undo parity — the one hard delete left).
ALTER TABLE "custom_metric_entries" ADD COLUMN "deleted_at" TIMESTAMP(3);
