-- Custom metrics remain isolated unless the owner explicitly opts into
-- correlation discovery. Existing definitions retain the isolated default.
ALTER TABLE "custom_metrics"
  ADD COLUMN "correlation_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Stable, user-scoped identity plus the latest statistically accepted evidence.
-- Dismissal baselines are retained independently of subsequent recomputation so
-- immaterial movement remains suppressed while a material change can resurface.
CREATE TABLE "correlation_patterns" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "canonical_key" TEXT NOT NULL,
  "family" TEXT NOT NULL,
  "factor_key" TEXT NOT NULL,
  "outcome_key" TEXT NOT NULL,
  "lag_days" INTEGER NOT NULL,
  "sample_size" INTEGER NOT NULL,
  "effect_size" DOUBLE PRECISION NOT NULL,
  "p_value" DOUBLE PRECISION NOT NULL,
  "q_value" DOUBLE PRECISION,
  "evidence_hash" TEXT NOT NULL,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  "last_computed_at" TIMESTAMP(3) NOT NULL,
  "dismissed_at" TIMESTAMP(3),
  "dismissed_evidence_hash" TEXT,
  "dismissed_effect_size" DOUBLE PRECISION,
  "dismissed_sample_size" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "correlation_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "correlation_patterns_user_id_canonical_key_key"
  ON "correlation_patterns"("user_id", "canonical_key");
CREATE INDEX "correlation_patterns_user_id_family_is_current_idx"
  ON "correlation_patterns"("user_id", "family", "is_current");

ALTER TABLE "correlation_patterns"
  ADD CONSTRAINT "correlation_patterns_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
