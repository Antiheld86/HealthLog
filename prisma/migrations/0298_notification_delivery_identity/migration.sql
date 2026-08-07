-- v1.37.0 — a notification names the health record it concerns and the
-- account whose channels receive it. The former remains the source of health
-- calculations and content; the latter owns delivery preferences and reach.
--
-- `user_id` remains as a legacy recipient mirror so established self-delivery
-- writers and bounded historical readers stay valid while every row gains the
-- explicit pair. The trigger maps an omitted pair to self-delivery, rejects a
-- partial or inconsistent pair, and refuses a managed profile as recipient.

ALTER TABLE "push_attempts"
    ADD COLUMN "record_user_id" TEXT,
    ADD COLUMN "recipient_user_id" TEXT;

UPDATE "push_attempts"
SET
    "record_user_id" = "user_id",
    "recipient_user_id" = "user_id";

ALTER TABLE "push_attempts"
    ALTER COLUMN "record_user_id" SET NOT NULL,
    ALTER COLUMN "recipient_user_id" SET NOT NULL;

ALTER TABLE "push_attempts"
    ADD CONSTRAINT "push_attempts_record_user_id_fkey"
    FOREIGN KEY ("record_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "push_attempts_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "push_attempts_recipient_user_id_created_at_desc_idx"
    ON "push_attempts" ("recipient_user_id", "created_at" DESC);

CREATE INDEX "push_attempts_record_user_id_created_at_desc_idx"
    ON "push_attempts" ("record_user_id", "created_at" DESC);

CREATE TABLE "notification_events" (
    "id" TEXT NOT NULL,
    "record_user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_events_record_user_id_fkey"
        FOREIGN KEY ("record_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_events_record_user_id_event_type_dedup_key_created_at_desc_idx"
    ON "notification_events" ("record_user_id", "event_type", "dedup_key", "created_at" DESC);

-- Tracking belongs to the account that received the Telegram message. The
-- prior subject-only key collapsed multiple delegated recipients into one row.
ALTER TABLE "telegram_reminder_messages"
    ADD COLUMN "recipient_user_id" TEXT;

UPDATE "telegram_reminder_messages" AS "message"
SET "recipient_user_id" = "medication"."user_id"
FROM "medications" AS "medication"
WHERE "medication"."id" = "message"."medication_id";

ALTER TABLE "telegram_reminder_messages"
    ALTER COLUMN "recipient_user_id" SET NOT NULL,
    ADD CONSTRAINT "telegram_reminder_messages_recipient_user_id_fkey"
        FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "telegram_reminder_messages_med_sched_date_phase_tod_key";

CREATE UNIQUE INDEX "telegram_reminder_messages_recipient_slot_key"
    ON "telegram_reminder_messages" (
        "recipient_user_id",
        "medication_id",
        "schedule_id",
        "date",
        "phase",
        "time_of_day"
    );

CREATE FUNCTION enforce_push_attempt_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.record_user_id IS NULL AND NEW.recipient_user_id IS NULL THEN
        NEW.record_user_id := NEW.user_id;
        NEW.recipient_user_id := NEW.user_id;
    ELSIF NEW.record_user_id IS NULL OR NEW.recipient_user_id IS NULL THEN
        RAISE EXCEPTION 'push attempt attribution requires both principals';
    ELSIF NEW.user_id <> NEW.recipient_user_id THEN
        RAISE EXCEPTION 'push attempt recipient must match user_id';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "users"
        WHERE "id" = NEW.recipient_user_id
          AND "managed_profile_at" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'managed profile cannot receive notification delivery';
    END IF;

    IF NEW.record_user_id <> NEW.recipient_user_id
       AND NOT EXISTS (
           SELECT 1
           FROM "users"
           WHERE "id" = NEW.record_user_id
             AND "managed_profile_at" IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'cross-principal delivery requires a managed record';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER push_attempt_attribution_guard
BEFORE INSERT OR UPDATE ON "push_attempts"
FOR EACH ROW
EXECUTE FUNCTION enforce_push_attempt_attribution();
