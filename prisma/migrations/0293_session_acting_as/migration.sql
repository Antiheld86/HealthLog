-- v1.36.0 — the cookie transport's acting-account carrier.
--
-- One nullable column, and the whole reason it is a column rather than
-- something the client sends: a browser cannot address this row. The session
-- cookie carries a 32-byte secret whose hash is the lookup key, so nothing
-- reachable from the client names, reads, or writes `acting_as_user_id`. The
-- only writer is the switch endpoint, which validates the grant first.
--
-- It is still a SELECTOR and not an authorization. The resolver joins it
-- against a live row in `account_grants` on every request, so a value stranded
-- here by a grant that has since been revoked or expired confers nothing at
-- all. Nothing sweeps this column for correctness — sweeping it (on revocation,
-- on account deletion) is housekeeping so the delegate's browser lands back in
-- its own account instead of on a wall of 403s.
--
-- ON DELETE SET NULL, not CASCADE. The two ends mean opposite things here:
-- deleting the session's OWNER should take the session with it (that is the
-- existing `user_id` cascade), while deleting the account being ACTED ON must
-- leave the delegate's browser session alive and simply put it back into its
-- own record. A CASCADE on this side would sign a delegate out of their own
-- account because somebody else deleted theirs.
--
-- The index is not for the resolver — that reads by primary key. It is for the
-- two sweeps that go the other way: revocation clearing every session of the
-- delegate pointing at this owner, and the SET NULL above when an account is
-- deleted. Both scan on this column.

ALTER TABLE "sessions" ADD COLUMN "acting_as_user_id" TEXT;

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_acting_as_user_id_fkey"
    FOREIGN KEY ("acting_as_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sessions_acting_as_user_id_idx"
    ON "sessions" ("acting_as_user_id");
