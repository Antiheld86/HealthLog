-- An intake import can now cover a whole regimen.
--
-- The per-medication import route scopes its job to one medication and the
-- column named it. A dose history exported from another tracker is one file for
-- every medication a person takes, so that job belongs to the account and each
-- payload entry names its own medication instead. NULL means "account-wide",
-- not "unknown"; the worker refuses a payload entry that names no medication
-- and no job row to fall back on.
--
-- Widening only: every existing row keeps its medication and the per-medication
-- route keeps writing one.
ALTER TABLE "medication_intake_import_jobs"
  ALTER COLUMN "medication_id" DROP NOT NULL;
