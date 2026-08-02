-- v1.36.0 — drop the address the delegate accepted from.
--
-- A consent record has to say who consented and when. It does not need to say
-- from where, and an address kept for as long as both accounts exist is
-- personal data held well past the point it answers anything. Nothing reads
-- the column; the acceptance is still recorded in `audit_logs` with its IP,
-- under that table's own retention.
--
-- Written before the feature shipped, so there is no data to migrate.
ALTER TABLE "account_grants" DROP COLUMN "accepted_ip";
