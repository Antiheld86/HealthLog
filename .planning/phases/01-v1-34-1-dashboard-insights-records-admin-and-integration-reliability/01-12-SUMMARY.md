---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "12"
subsystem: testing
tags: [apple-health, ecg, zip, encryption, postgres, whoop, tdd]

requires:
  - phase: 01-09
    provides: Focused security gate before product and reliability contracts
provides:
  - RED streaming archive and incremental HKElectrocardiogram CSV parser contracts
  - RED real-Postgres encrypted ECG persistence and fail-soft worker contracts
  - Green source-agnostic HealthKit and direct WHOOP API regressions
affects: [01-19, apple-health-import, ecg-recordings, whoop]

tech-stack:
  added: []
  patterns:
    - Real ZIP fixtures enter through the archive path rather than trusted extracted files
    - Real-Postgres failure injection uses a temporary database trigger to verify transactional fail-soft behavior

key-files:
  created:
    - src/lib/measurements/__tests__/apple-health-ecg-import.test.ts
    - src/lib/jobs/__tests__/apple-health-import-ecg.test.ts
    - tests/integration/apple-health-import-ecg.test.ts
  modified:
    - src/lib/sources/__tests__/source-priority-whoop-applehealth.test.ts
    - src/lib/whoop/__tests__/sync-user-whoop.test.ts

key-decisions:
  - "Plan 19 must expose streamAppleHealthEcgMembers and parseAppleHealthEcgCsv so archive bytes are bounded before persistence."
  - "Stable ECG identity is content-bound and tenant-scoped: filenames do not identify recordings, while identical normalized content does."
  - "HealthKit rows written by WHOOP remain APPLE_HEALTH imports, and no direct WHOOP ECG capability is implied."

patterns-established:
  - "Security RED contracts: malicious ZIP metadata and actual decompressed bytes are tested independently."
  - "Privacy RED contracts: assertions cover database ciphertext, job results, failure messages, logs, and staged-file cleanup."

requirements-completed: [HK-01, HK-02, HK-03, HK-04, HK-05, HK-06, HK-07]

duration: 9min
completed: 2026-07-29
---

# Phase 1 Plan 12: Apple ECG and WHOOP RED Contract Summary

**Streaming ZIP, ECG normalization, encrypted persistence, fail-soft XML survival, and source-agnostic WHOOP behavior pinned before Plan 19 implementation**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-29T12:11:46Z
- **Completed:** 2026-07-29T12:21:02Z
- **Tasks:** 1
- **Files modified:** 5

## Accomplishments

- Added real ZIP fixtures for recognized ECG members plus traversal, duplicate names, encryption, unsupported compression, claimed-ratio bombs, actual-byte overruns, aggregate bytes, member counts, and sample limits.
- Pinned incremental CSV normalization, known device-classification passthrough, unknown-classification null behavior, malformed value/date rejection, and non-diagnostic/no-plaintext output.
- Added real-Postgres worker contracts for encryption/decryption, content-bound idempotency, distinct recordings, tenant isolation, parser revision reprocessing, malformed/unsafe auxiliary fail-soft behavior, mid-write rollback, and valid XML survival.
- Preserved 20 green unit regressions covering source priority, WHOOP-written supported HealthKit records as `APPLE_HEALTH`, direct WHOOP API orchestration, and the explicit absence of a WHOOP ECG claim.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin safe bounded Apple Health ECG auxiliary import** - `6cc3de824` (test, RED)

## Files Created/Modified

- `src/lib/measurements/__tests__/apple-health-ecg-import.test.ts` - Streaming archive and incremental ECG CSV parser attack/positive matrix.
- `src/lib/jobs/__tests__/apple-health-import-ecg.test.ts` - Parser revision, fail-soft worker wiring, bounded progress, privacy, and no-diagnosis contracts.
- `tests/integration/apple-health-import-ecg.test.ts` - End-to-end worker contracts against migrated PostgreSQL and the existing encrypted `EcgRecording` model.
- `src/lib/sources/__tests__/source-priority-whoop-applehealth.test.ts` - Source-agnostic WHOOP-written HealthKit regressions and no ECG inference.
- `src/lib/whoop/__tests__/sync-user-whoop.test.ts` - Direct WHOOP resource orchestration regression and explicit no-ECG claim.

## Decisions Made

- The archive contract accepts an archive path and yields only stream handles with normalized member names; it never returns a filesystem path for an auxiliary ECG.
- Limits are injectable in tests so every byte/count/compression boundary is exercised with small fixtures, while production can use safe real-world defaults.
- The CSV contract converts waveform values to integer microvolts and carries only the recording timestamp, sampling frequency, samples, lead, average heart rate, and mapped device verdict.
- Only `Sinus Rhythm`, `Atrial Fibrillation`, and `Inconclusive` map to existing device-verdict enums; localized or unknown classifications persist as null.
- The real worker, not a persistence mock, owns the integration contract. A temporary PostgreSQL trigger forces a write failure and is dropped in `finally`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Initial positive fixtures assumed the canonical type name was `HEART_RATE`; the established mapping correctly emits `PULSE`, so the source-agnostic and XML-survival assertions were corrected before commit.
- Direct WHOOP resource mocks receive a second options object; the regression was aligned to the real call shape and is green.
- Repository-wide `pnpm typecheck` remains RED only in concurrently added Google Health contract files (`sync-progress.test.ts` and `google-health-sync-progress.test.ts`). After correcting Plan 01-12's regular-expression target compatibility, no type errors point to the five Apple ECG/WHOOP files.

## Verification Evidence

- Unit gate: **expected RED**, 27 failed ECG archive/parser/worker implementation contracts; 20 source/WHOOP regressions passed.
- Real-Postgres gate: **expected RED**, 7 failed ECG persistence/result contracts after a successful container boot and all 280 migrations.
- Focused ESLint: passed for all five owned files.
- Prettier and `git diff --check`: passed for all five owned files.
- Gitleaks pre-commit hook: passed.

## User Setup Required

None - this plan adds test contracts only.

## Next Phase Readiness

- Plan 19 has executable API, security-limit, normalization, persistence, privacy, progress, and compatibility contracts.
- The RED failures are attributable to the missing Apple ECG modules/worker branch and existing parser revision 2, not fixture or infrastructure failures.

## Self-Check: PASSED

- All five owned test files exist.
- Task commit `6cc3de824` exists on the current branch.
- No production, schema, migration, package, lockfile, locale, Google, or unrelated job test was changed by Plan 01-12.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
