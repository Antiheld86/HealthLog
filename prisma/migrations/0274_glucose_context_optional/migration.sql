-- v1.32.x — a blood-glucose reading may carry no context.
--
-- Migration 0021 introduced `measurements.glucose_context` with a CHECK that
-- read both ways at once: a BLOOD_GLUCOSE row MUST carry a context, and every
-- other type MUST NOT. The second half is right and stays. The first half was
-- written when the only glucose writer was the manual entry form, where a
-- person picks fasting / post-meal / random / bedtime at the moment of the
-- reading.
--
-- Every machine writer that arrived later has no such classification per
-- sample: a continuous sensor export, the Nightscout SGV pull, the MCP
-- `log_measurement` tool and the Telegram numeric capture all build their row
-- without a context, so the insert failed against this constraint — a CSV
-- import of a sensor history wrote nothing, a Nightscout tick counted every
-- reading as a failed row.
--
-- A missing context is missing. It stores as NULL, never as a fifth enum
-- member: every per-context reader (the doctor report, the FHIR per-context
-- Observations, the analytics + dashboard breakdowns, the target builder)
-- selects by equality against the four members, so NULL falls out of each
-- rather than being presented as a classification that nobody recorded. The
-- context-agnostic readers (the clinical panel, the charts, the all-time
-- summary) keep the row in full.
ALTER TABLE "measurements"
  DROP CONSTRAINT IF EXISTS "measurements_glucose_context_requires_type";

ALTER TABLE "measurements"
  ADD CONSTRAINT "measurements_glucose_context_requires_type"
  CHECK (
    type = 'BLOOD_GLUCOSE' OR glucose_context IS NULL
  );
