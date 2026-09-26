-- When a browser session last re-proved a credential the account holds.
--
-- Exporting the whole record, making a share link, minting a token and the
-- admin backup / reset / wipe actions now ask for a fresh proof, not just a
-- live session. A second-factor proof keeps stamping `mfa_verified_at`, as it
-- always has. A password proof on an account without a second factor stamps
-- this column instead, so a password never satisfies a gate that asks for a
-- second factor. Nullable, no default: a session that never re-proved has none.
ALTER TABLE "sessions" ADD COLUMN "reproof_at" TIMESTAMP(3);
