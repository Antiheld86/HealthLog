-- v1.37.0 — a grant can open part of a record, and a grant can hand it over.
--
-- Two additive changes, no backfill, no re-consent, and no existing row
-- changes meaning:
--
--   * `scope_json` is NULL on every row that exists, and NULL means the entire
--     record. That is not a default standing in for a missing answer — it is
--     the answer every one of those rows was actually consented as, before
--     narrowing was a thing anybody could ask for. A non-NULL value is a
--     non-empty array of section keys from the closed vocabulary in
--     `src/lib/sharing/scope.ts`.
--   * `MANAGE` joins the level enum. No row becomes MANAGE here; the value
--     exists so a row can state the level instead of implying it, the same
--     reason `account_grant_access` was a type rather than a boolean from day
--     one (migration 0292).
--
-- Json rather than a text[] or a join table. A join table would be the
-- normalised answer and it would be the wrong one: the set is read on every
-- delegated request as part of deciding an authorization, so it belongs on the
-- row the resolver already loads, and it is written exactly once, at
-- invitation, by a machine — never edited, never queried across grants. There
-- is no in-place widening anywhere in this feature, so the set has no update
-- path to keep consistent. A text[] would carry the same shape with a
-- Postgres-specific type Prisma models less directly, for no read this
-- product performs.
--
-- No CHECK constraint asserting the array is non-empty, well-formed, or absent
-- on a MANAGE row. Those three conditions are enforced in
-- `src/lib/sharing/grants.ts`, at the one function that writes the column, and
-- the reason is the same one migrations 0290 and 0292 gave for declining their
-- own CHECKs: the delete-all-data guard seeds a row into every table by
-- walking `information_schema`, and a constraint it cannot satisfy breaks a
-- fixture whose whole value is that nobody hand-writes it. The READ side is
-- what actually protects the record anyway — `normaliseScope` resolves a
-- malformed blob to the empty set and refuses every section, so a bad value
-- that reached the column by any route grants nothing rather than everything.

ALTER TYPE "account_grant_access" ADD VALUE 'MANAGE';

ALTER TABLE "account_grants" ADD COLUMN "scope_json" JSONB;
