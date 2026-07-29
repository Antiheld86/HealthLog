---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "19"
subsystem: apple-health-import
tags: [apple-health, ecg, zip, encryption, postgres, privacy]

requires:
  - phase: 01-12
    provides: Apple Health ECG archive, persistence, privacy, and WHOOP contract tests
provides:
  - Path-safe bounded Apple Health ECG ZIP member reader
  - Incremental ECG CSV normalization with device-only classification
  - Encrypted content-addressed APPLE_HEALTH EcgRecording persistence
  - Fail-soft ECG worker branch and privacy-safe result counters
  - Exact Apple Health ECG and WHOOP limitation documentation
affects: [apple-health-import, ecg, settings-import, whoop-documentation]

tech-stack:
  added: []
  patterns:
    - Central-directory validation followed by actual decompressed-byte enforcement
    - Auxiliary health artifacts fail softly beside the canonical XML transaction
    - Content-derived identity scoped by the existing tenant-aware database unique key

key-files:
  created:
    - src/lib/apple-health/archive-stream.ts
    - src/lib/apple-health/ecg-csv.ts
    - src/lib/apple-health/ecg-import.ts
  modified:
    - src/lib/jobs/apple-health-import-worker.ts
    - src/lib/measurements/import-apple-health-export.ts
    - src/app/api/import/apple-health-export/[jobId]/status/route.ts
    - src/components/settings/import-panel/apple-health-import-card.tsx
    - docs/integrations/apple-health.md

key-decisions:
  - "Validate the complete ZIP directory before yielding ECG data and enforce both declared and actual decompression bounds."
  - "Derive externalRecordingId from normalized ECG content, leaving tenant separation to the existing compound unique key."
  - "Preserve only known source-device rhythm classifications; unknown labels remain null and waveforms are never diagnostically interpreted."
  - "Complete the canonical export.xml import before the fail-soft auxiliary ECG branch so bad ECGs cannot roll back valid XML data."

patterns-established:
  - "ECG result envelopes contain only discovered/imported/updated/skipped/failed integer counters."
  - "Raw ECG samples are encrypted before a database transaction begins and scrubbed after the write attempt."

requirements-completed: [HK-01, HK-02, HK-03, HK-04, HK-05, HK-06, HK-07]

duration: 10min
completed: 2026-07-29
---

# Phase 01 Plan 19: Apple Health ECG Import Summary

**Bounded path-safe ECG archive ingestion with AES-256-GCM persistence, content-stable identity, fail-soft XML coexistence, and privacy-safe progress counters**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-29T12:39:00Z
- **Completed:** 2026-07-29T12:48:47Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Added a no-temp-file ZIP reader that rejects traversal, duplicate names, encryption, unsupported methods, forged metadata, compression bombs, and actual byte overruns.
- Parsed Apple ECG CSVs incrementally into bounded integer-microvolt waveforms while discarding patient/source labels and accepting only known device classifications.
- Persisted APPLE_HEALTH ECGs through the existing encryption codec and `EcgRecording` model with filename-independent idempotency and transactional rollback.
- Kept valid WHOOP-written and other supported `export.xml` records successful when an auxiliary ECG is malformed, unsafe, or cannot be written.
- Exposed only bounded ECG counters to the status route and card, and documented exact limits and WHOOP export constraints.

## Task Commits

Each task was committed atomically:

1. **Task 1: Stream only safe bounded ECG archive members** - `f06137c0d`
2. **Task 2: Encrypt and idempotently persist source-device ECG records** - `a686c7200`
3. **Task 3: Expose bounded progress and document exact support** - `4b64556b3`
4. **Task 2 follow-up: Avoid phantom ECG failure counts** - `addd6b700`

## Files Created/Modified

- `src/lib/apple-health/archive-stream.ts` - Validates ZIP structure and streams only bounded ECG CSV data.
- `src/lib/apple-health/ecg-csv.ts` - Incrementally normalizes ECG descriptors and waveform samples.
- `src/lib/apple-health/ecg-import.ts` - Derives stable identity, encrypts samples, and transactionally upserts recordings.
- `src/lib/jobs/apple-health-import-worker.ts` - Runs ECG ingestion as a parser-revision-3 fail-soft auxiliary branch.
- `src/lib/measurements/import-apple-health-export.ts` - Defines the bounded ECG result envelope.
- `src/app/api/import/apple-health-export/[jobId]/status/route.ts` - Sanitizes ECG outcomes to five non-negative counters.
- `src/components/settings/import-panel/apple-health-import-card.tsx` - Renders ECG-only success and partial outcomes.
- `docs/integrations/apple-health.md` - Documents supported ECG behavior, bounds, privacy, idempotency, and WHOOP limitations.

## Decisions Made

- Used Node's existing ZIP/zlib capabilities and no new dependency or schema change.
- Kept content identity identical across users while relying on `(userId, source, externalRecordingId)` for tenant-safe deduplication.
- Treated source-device classification as a stored fact only; no waveform analysis, inference, or diagnosis was added.
- Stored ECG counters only in job results; filenames, writer labels, samples, values, and raw per-ECG failures do not enter result or logging output.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Prevented a phantom failed-ECG count**

- **Found during:** Final review after Task 3
- **Issue:** A structural archive error with zero discovered ECG members could increment `failed` to one.
- **Fix:** Archive-level failure accounting now increments only for discovered ECG artifacts not already represented by another terminal counter.
- **Files modified:** `src/lib/jobs/apple-health-import-worker.ts`
- **Verification:** Worker ECG source contract and full Plan 12 unit matrix pass.
- **Committed in:** `addd6b700`

---

**Total deviations:** 1 auto-fixed bug
**Impact on plan:** Corrected bounded-counter accuracy without expanding scope.

## Verification

- Plan 12 and regression unit suites: **107 tests passed across 8 files**.
- Real PostgreSQL Apple Health suites: **25 tests passed across 4 files**, including ECG encryption/idempotency/rollback, worker failures, natural keys, and orphan reconciliation.
- Focused ESLint, Prettier, documentation diff, and privacy/source-contract checks passed.
- Repository-wide `pnpm typecheck` is currently blocked only by concurrent Google Health work: a not-yet-created status route and test mock tuple typing in `src/lib/google-health/**`. No Plan 19 file appears in the TypeScript error output.

## Issues Encountered

- The Task 3 verification command references `src/components/settings/import-panel/__tests__/apple-health-import-card.test.tsx`, but that file does not exist in the Plan 12 test commit. The available import-panel component suite was run instead and passed.
- Concurrent plans modified package locks, Prisma schema/migrations, and job files during execution. None were staged in Plan 19 commits.

## User Setup Required

None - no new dependency, migration, environment variable, or external service configuration is required.

## Next Phase Readiness

- Apple Health ECG import is ready for release-level validation.
- Plan 23 remains the sole owner of locale JSON; the card therefore uses the permitted temporary English ECG outcome copy.

## Self-Check: PASSED

- All eight implementation/documentation files exist.
- Task commits `f06137c0d`, `a686c7200`, `4b64556b3`, and `addd6b700` exist.

---

*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
