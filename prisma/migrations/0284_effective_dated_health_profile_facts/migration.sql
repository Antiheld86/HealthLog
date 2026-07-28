-- v1.34.0 — section-level prompt inclusion and encrypted, effective-dated
-- health-profile facts.
--
-- The inclusion list is closed and starts with every section that existed when
-- this migration landed. Future enum members do not enter the static default,
-- so adding a section cannot silently widen prompt context.
--
-- Fact answers are encrypted BYTEA. The only plaintext classification is the
-- closed fact kind and its provenance. Corrections close the previous row and
-- mint a successor, preserving half-open [valid_from, valid_until) history.

CREATE TYPE "health_profile_ai_section" AS ENUM (
    'ABOUT_ME',
    'CONDITIONS',
    'ALLERGIES',
    'COACH_FOCUS',
    'FAMILY_HISTORY',
    'SMOKING_STATUS',
    'ALCOHOL_PATTERN',
    'SHIFT_SCHEDULE'
);

CREATE TYPE "health_profile_fact_kind" AS ENUM (
    'SMOKING_STATUS',
    'ALCOHOL_PATTERN',
    'SHIFT_SCHEDULE'
);

CREATE TYPE "health_profile_fact_provenance" AS ENUM (
    'USER_REPORTED',
    'USER_CORRECTION'
);

ALTER TABLE "user_health_profiles"
    ADD COLUMN "ai_included_sections" "health_profile_ai_section"[] NOT NULL
    DEFAULT ARRAY[
        'ABOUT_ME'::"health_profile_ai_section",
        'CONDITIONS'::"health_profile_ai_section",
        'ALLERGIES'::"health_profile_ai_section",
        'COACH_FOCUS'::"health_profile_ai_section",
        'FAMILY_HISTORY'::"health_profile_ai_section",
        'SMOKING_STATUS'::"health_profile_ai_section",
        'ALCOHOL_PATTERN'::"health_profile_ai_section",
        'SHIFT_SCHEDULE'::"health_profile_ai_section"
    ];

CREATE TABLE "health_profile_fact_revisions" (
    "id"                         TEXT NOT NULL,
    "user_id"                    TEXT NOT NULL,
    "kind"                       "health_profile_fact_kind" NOT NULL,
    "value_encrypted"            BYTEA NOT NULL,
    "valid_from"                 TIMESTAMPTZ(6) NOT NULL,
    "valid_until"                TIMESTAMPTZ(6),
    "provenance"                 "health_profile_fact_provenance" NOT NULL DEFAULT 'USER_REPORTED',
    "superseded_by_revision_id"  TEXT,
    "created_at"                 TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_profile_fact_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "health_profile_fact_revisions_valid_interval_check"
        CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
    CONSTRAINT "health_profile_fact_revisions_not_self_superseded_check"
        CHECK ("superseded_by_revision_id" IS NULL OR "superseded_by_revision_id" <> "id")
);

CREATE UNIQUE INDEX "health_profile_fact_revisions_user_kind_valid_from_key"
    ON "health_profile_fact_revisions" ("user_id", "kind", "valid_from");

-- Exactly one current, non-superseded row may exist for a user and fact kind.
-- Prisma cannot express this partial unique index, so the migration owns it.
CREATE UNIQUE INDEX "health_profile_fact_revisions_one_current"
    ON "health_profile_fact_revisions" ("user_id", "kind")
    WHERE "valid_until" IS NULL AND "superseded_by_revision_id" IS NULL;

CREATE INDEX "health_profile_fact_revisions_user_kind_valid_from_desc_idx"
    ON "health_profile_fact_revisions" ("user_id", "kind", "valid_from" DESC);

CREATE INDEX "health_profile_fact_revisions_superseded_by_idx"
    ON "health_profile_fact_revisions" ("superseded_by_revision_id");

ALTER TABLE "health_profile_fact_revisions"
    ADD CONSTRAINT "health_profile_fact_revisions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "health_profile_fact_revisions"
    ADD CONSTRAINT "health_profile_fact_revisions_superseded_by_fkey"
    FOREIGN KEY ("superseded_by_revision_id")
    REFERENCES "health_profile_fact_revisions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
