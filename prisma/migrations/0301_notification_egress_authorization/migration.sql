-- v1.37.0 — a managed Guardian notification receives a durable final
-- authorization claim under the profile lifecycle lock before provider I/O.
-- This records only delivery principals and outcome, never health content or
-- channel credentials. Retention follows the notification attempt cleanup.
CREATE TABLE "notification_egress_authorizations" (
    "id" TEXT NOT NULL,
    "record_user_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "authorized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "notification_egress_authorizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_egress_authorizations_record_user_id_fkey"
        FOREIGN KEY ("record_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_egress_authorizations_recipient_user_id_fkey"
        FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_egress_authorizations_authorized_at_idx"
    ON "notification_egress_authorizations" ("authorized_at");

CREATE INDEX "notification_egress_authorizations_record_user_id_recipient_user_id_authorized_at_idx"
    ON "notification_egress_authorizations" (
        "record_user_id",
        "recipient_user_id",
        "authorized_at" DESC
    );
