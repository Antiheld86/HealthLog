-- The tables of values a Coach turn read, stored with the assistant message
-- that showed them: a JSON array of result tables, AES-256-GCM encrypted in
-- the same Bytes codec as the message body. The values are health data, so
-- they never sit in the plaintext `metric_source_json`, which carries only the
-- tables' metadata (ref, source, shape, row count).
--
-- A stored table keeps the values the answer was given with; a later edit or
-- sync does not rewrite what an earlier answer showed. The column goes with
-- its row, so deleting a conversation or wiping the account removes it by
-- the existing cascade.
--
-- Additive only: a nullable column, no table rewrite, no data change.

ALTER TABLE "coach_messages" ADD COLUMN "results_encrypted" BYTEA;
