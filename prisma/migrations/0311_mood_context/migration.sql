-- v1.38 — the day's context around a mood entry.
--
-- Work, contacts, leisure and a notable event, as an optional sub-row rather
-- than as twenty more columns on `mood_entries`. Level A went the other way in
-- migration 0310, and for the opposite reasons: those five values are on
-- nearly every row and every mood reader wants them, while this is sparse by
-- design (only the sections somebody opened produce anything at all) and only
-- the context surfaces read it.
--
-- An entry with nothing filled in gets NO row here. A table of all-NULL rows
-- would record "asked and answered nothing" where the truth is "never asked",
-- and the two are different facts.
--
-- Nothing in this table duplicates another module. Sleep, activity and vitals
-- are resolved at read time from the modules that own them, and body symptoms
-- stay in the illness tables. A stored copy would be a second home for the
-- same fact and would drift the first time somebody corrected the original.
--
-- The two multi-select lists are JSON arrays in TEXT columns, matching the
-- `mood_entries.tags` convention. Not queryable, read whole — acceptable
-- because every reader wants an entry's whole context anyway.
--
-- No CHECK constraints on the numeric ranges. Bounds are enforced server-side,
-- the same way `mood_entry_tag_links.rating` documents: a later change to a
-- scale must not strand rows written under the old one.

CREATE TABLE "mood_contexts" (
    "mood_entry_id"      TEXT NOT NULL,
    "user_id"            TEXT NOT NULL,

    -- Work. `work_status` is one of off / partial / regular / overtime.
    "work_status"        TEXT,
    "work_minutes"       INTEGER,
    "overtime_minutes"   INTEGER,
    "work_load"          INTEGER,
    "work_satisfaction"  INTEGER,

    -- Contacts. `contact_circles` is a JSON array of circle keys; the count is
    -- never scored, which is why the experienced quality is its own column.
    "contact_circles"    TEXT,
    "contact_form"       TEXT,
    "contact_extent"     TEXT,
    "contact_quality"    INTEGER,
    "contact_support"    INTEGER,

    -- Leisure. `leisure_categories` is a JSON array of category keys.
    "leisure_categories" TEXT,
    "leisure_minutes"    INTEGER,
    "leisure_joy"        INTEGER,
    "leisure_recovery"   INTEGER,

    -- One notable event, if there was one.
    "event_type"         TEXT,
    "event_valence"      INTEGER,
    "event_at"           TIMESTAMPTZ(3),

    -- One AES-256-GCM note for the whole context, not one per section: four
    -- ciphertext columns would be four rotation entries and four ways to
    -- forget one. Registered in ENCRYPTED_COLUMNS and in the rotation script.
    "notes_encrypted"    BYTEA,

    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mood_contexts_pkey" PRIMARY KEY ("mood_entry_id")
);

-- Deleting the entry deletes its context. The context has no meaning without
-- the entry it describes, and a row pointing at a deleted entry would be
-- readable by nobody and deletable by nobody. The user cascade matches every
-- other user-scoped table here.
ALTER TABLE "mood_contexts"
  ADD CONSTRAINT "mood_contexts_mood_entry_id_fkey"
  FOREIGN KEY ("mood_entry_id") REFERENCES "mood_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mood_contexts"
  ADD CONSTRAINT "mood_contexts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The user-scoped sweep: the context analytics read a window of an account's
-- contexts, and the account-deletion path clears them by owner.
CREATE INDEX "mood_contexts_user_id_idx" ON "mood_contexts"("user_id");
