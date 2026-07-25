-- One-shot Fitbit sleep duplicate repair (stable per-segment sleep keys).
-- Null = repair pending; stamped once the boot-time bounded sleep re-read
-- completes for the connection.
ALTER TABLE "fitbit_connections" ADD COLUMN "sleep_repaired_at" TIMESTAMP(3);
