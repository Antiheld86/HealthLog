-- v1.36.0 — one account's standing permission to read another account's record.
--
-- The row IS the consent record. There is no second receipt table, because two
-- records of one act is the failure this project keeps paying for: they drift,
-- and then nobody can say which one is true. Every fact about the delegation —
-- who offered it, who accepted it and from where, when it ends, who ended it —
-- is a column here.
--
-- That decision is what shapes the rest of the table:
--
--   * Revocation NEVER deletes. It stamps `revoked_at` and `revoked_by`. A
--     deleted row would erase the answer to "who had access, from when to
--     when, and who ended it", which is precisely the question an owner is
--     owed and the one a deletion cannot answer.
--   * The uniqueness constraint is therefore PARTIAL. A plain
--     UNIQUE (grantor_id, grantee_id) cannot coexist with revocation-as-record:
--     re-inviting the same person after a revocation would either violate it or
--     force a reuse of the old row, and reuse destroys the first grant's
--     history. `WHERE revoked_at IS NULL` keeps the invariant that matters —
--     at most one LIVE grant per pair — while every historical row persists.
--   * Nothing here is deleted by the application at all. The two cascades below
--     are the only deletion path, and they exist because a grant row naming a
--     user who no longer exists is a dangling authorization: it would be
--     resolvable by nobody and revocable by nobody. Both directions cascade,
--     not just the grantor side.
--
-- `access` exists from day one and only ever holds 'READ' in v1. It is a type
-- rather than a boolean so the v2 write question is enforcement work rather
-- than migration work, and so a row states its level instead of implying it.
--
-- Self-grants are refused in `src/lib/sharing/grants.ts`, not by a CHECK here.
-- The reason is concrete rather than stylistic: the delete-all-data integration
-- guard seeds one row into every table in the schema by walking
-- `information_schema`, and it binds every foreign key that points at `users`
-- to the one account under test — so the row it plants here necessarily has
-- grantor_id = grantee_id. A CHECK would break a fixture whose whole value is
-- that nobody hand-writes it. Migration 0290 declined a CHECK for the same
-- seeder's sake and said so; this follows it.
--
-- Timestamps: `invited_at` is the domain event and moves if an invitation is
-- re-offered on the same pending row; `created_at` is row bookkeeping and never
-- moves. They agree on the day the row is written and are allowed to disagree
-- afterwards, which is why both are here.

CREATE TYPE "account_grant_access" AS ENUM ('READ', 'WRITE');

-- Owner revoked, or delegate renounced. The record says which, because "access
-- ended" and "the person given access handed it back" are different facts.
CREATE TYPE "account_grant_revoker" AS ENUM ('GRANTOR', 'GRANTEE');

CREATE TABLE "account_grants" (
    "id"           TEXT NOT NULL,
    "grantor_id"   TEXT NOT NULL,
    "grantee_id"   TEXT NOT NULL,
    "access"       "account_grant_access" NOT NULL DEFAULT 'READ',
    "invited_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at"  TIMESTAMPTZ(3),
    "accepted_ip"  TEXT,
    "revoked_at"   TIMESTAMPTZ(3),
    "revoked_by"   "account_grant_revoker",
    "expires_at"   TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_grants_pkey" PRIMARY KEY ("id"),
    -- A revoked row states who ended it; a live row cannot claim a revoker.
    -- Both halves, so neither an unattributed revocation nor a revoker without
    -- a revocation can be written.
    CONSTRAINT "account_grants_revoked_by_check"
        CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);

-- At most one LIVE grant per (owner, delegate). Revoked rows fall out of the
-- index, so history accumulates without ever blocking a re-invitation.
CREATE UNIQUE INDEX "account_grants_live_pair_key"
    ON "account_grants" ("grantor_id", "grantee_id")
    WHERE "revoked_at" IS NULL;

-- The delegate's "whose records may I open" list, newest first.
CREATE INDEX "account_grants_grantee_id_created_at_idx"
    ON "account_grants" ("grantee_id", "created_at" DESC);

-- The owner's sharing panel: every grant they ever made, live and historical.
CREATE INDEX "account_grants_grantor_id_created_at_idx"
    ON "account_grants" ("grantor_id", "created_at" DESC);

ALTER TABLE "account_grants"
    ADD CONSTRAINT "account_grants_grantor_id_fkey"
    FOREIGN KEY ("grantor_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_grants"
    ADD CONSTRAINT "account_grants_grantee_id_fkey"
    FOREIGN KEY ("grantee_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
