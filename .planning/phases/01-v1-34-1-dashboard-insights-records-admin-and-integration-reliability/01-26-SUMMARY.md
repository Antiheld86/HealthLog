---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "26"
subsystem: workout-canonicalization
tags: [workouts, whoop, apple-health, heart-rate, canonical-projection]

requires:
  - phase: 01-10
    provides: RED product/UI regression contracts
  - phase: 01-15
    provides: App01 privacy-safe performance and production evidence
provides:
  - Canonical Apple workout identity enriched with missing WHOOP HR aggregates and sanitized device zones
  - Shared list/detail canonical projection without cross-user, cross-sport, cross-window or duplicate donor joins
  - Honest aggregate pulse visibility independent of continuous workout samples
affects: [workout-list, workout-detail, whoop, apple-health, effort-zones]

tech-stack:
  added: []
  patterns:
    - one-to-one nearest-donor matching inside the existing fixed canonical bucket
    - allowlisted fill-missing-only enrichment with sanitized WHOOP zone keys
    - aggregate pulse and continuous-series availability remain separate capabilities

key-files:
  created: []
  modified:
    - src/lib/measurements/pick-canonical-workout-rows.ts
    - src/lib/workouts/list-read.ts
    - src/app/api/workouts/[id]/route.ts
    - src/components/insights/workout-list.tsx

key-decisions:
  - "Canonical id, source, route, samples and existing values remain owned by the winning row."
  - "Only missing avgHeartRate, maxHeartRate and validated WHOOP zone durations may cross the twin boundary."
  - "A WHOOP aggregate never implies or fabricates a continuous heart-rate curve."

patterns-established:
  - "Donor safety: deterministic one-to-one assignment prevents one WHOOP record enriching multiple same-slot occurrences."
  - "Metadata safety: copy only six known non-negative zone-duration keys and reject malformed known values."

requirements-completed: [WHR-01, WHR-02, WHR-03, WHR-04, WHR-05]

duration: 7min
completed: 2026-07-29
---

# Phase 01 Plan 26: Workout Pulse Canonical Enrichment Summary

**Apple remains the canonical workout while its missing pulse aggregates and device zones now surface from the exact matched WHOOP twin, without inventing a continuous curve.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-29T12:53:55Z
- **Completed:** 2026-07-29T13:00:30Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Extended the active canonical picker with immutable, fill-missing-only WHOOP enrichment while preserving the winner's identity and all existing values.
- Added user identity to bucket isolation when available and deterministic one-to-one donor assignment so a donor cannot enrich two distinct same-slot occurrences.
- Sanitized WHOOP zones down to the six documented non-negative duration keys; arbitrary donor metadata and malformed zone payloads do not cross into the winner.
- Wired list and detail reads through the same enriched envelope. The detail still owns its original route, samples, metadata response and ownership check while its aggregate statistics and zone computation use the enriched projection.
- Added an average-pulse list value independent of the detailed-series glyph and pinned that aggregate HR/zones alone still produce no curve.

## Task Commits

Each task was committed atomically:

1. **Task 1: Enrich only the matched canonical projection**
   - `1cb0f7dd6` - RED positive and negative enrichment regressions
   - `635e9b64c` - deterministic fill-missing-only projection
   - `d2f6bf33e` - narrow WHOOP-zone sanitization and isolation coverage
2. **Task 2: Use the enriched envelope consistently in list and detail**
   - `ed63a3bf3` - RED list/detail envelope regressions
   - `43cce0801` - shared enriched list/detail reads
3. **Task 3: Render aggregate pulse honestly and pin the no-curve boundary**
   - `89fefce7a` - RED aggregate-versus-series regressions
   - `f6555d471` - aggregate average pulse in the workout list

Supporting cleanup:

- `104a05809` - repository formatting for the workout enrichment changes

## Files Created/Modified

- `src/lib/measurements/pick-canonical-workout-rows.ts` - Enriches winners from deterministic WHOOP twins using only validated allowlisted fields.
- `src/lib/measurements/__tests__/pick-canonical-workout-rows.test.ts` - Covers positive enrichment, non-overwrite, no mutation, sport/window/user isolation, malformed metadata and one-to-one donor use.
- `src/lib/workouts/list-read.ts` - Selects metadata for the shared canonical projection and returns enriched HR aggregates.
- `src/app/api/workouts/[id]/route.ts` - Computes detail aggregates and zones from the enriched canonical envelope while keeping the owned row's route/samples.
- `src/app/api/workouts/__tests__/canonical-dedup.test.ts` - Pins one enriched Apple list row for an Apple/WHOOP twin.
- `src/app/api/workouts/__tests__/detail.test.ts` - Pins Apple identity/route/metadata preservation, WHOOP HR/zones and non-overwrite behavior.
- `src/components/insights/workout-list.tsx` - Shows average pulse in bpm independently of continuous-series availability.
- `src/components/insights/__tests__/workout-list.test.tsx` - Separates aggregate visibility from the series glyph.
- `src/lib/workouts/__tests__/hr-series.test.ts` - Proves aggregates and zones cannot synthesize a curve.

## Decisions Made

- Kept the existing fixed five-minute/sport canonical boundary unchanged. Enrichment narrows behavior inside an already accepted twin bucket rather than widening dedup.
- Matched multiple winners and WHOOP donors by nearest start time with stable input-index tie-breaks and one-to-one consumption.
- Returned the original detail metadata envelope unchanged; sanitized donor zones feed only the established zone parser. This avoids leaking arbitrary WHOOP metadata into an Apple-owned API row.
- Kept `hasHrSeries` tied only to real `WorkoutSamples`; the new bpm label is the truthful aggregate-only signal.

## Deviations from Plan

None - implementation stayed within the nine declared files, plus this required summary. No schema, migration, sync, locale, package or dependency change was made.

## Verification

- **Focused regression cluster:** 6 files, 84 tests passed.
- **Picker regressions:** 21/21 passed, including cross-user and one-to-one donor isolation.
- **ESLint:** Passed for all nine owned source/test files.
- **Prettier:** Passed for all nine owned source/test files.
- **Diff check:** Passed.
- **TypeScript:** Repository-wide `pnpm typecheck` remains temporarily non-zero only in concurrent Google Health RED work (`sync/status/route` not yet landed and mock tuple diagnostics). No diagnostic references a Plan 01-26 file.

## Issues Encountered

- Concurrent Google Health implementation temporarily blocks the repository-wide typecheck. The failure set is confined to its status-route and sync-progress tests and was not modified here.

## User Setup Required

None.

## Next Phase Readiness

- WHR-01 through WHR-05 are closed with positive and negative regression coverage.
- The release can surface existing App01 WHOOP aggregate data immediately after deployment; historical data does not require a resync or migration.
- Continuous WHOOP curves remain intentionally unavailable because the public WHOOP API does not expose continuous heart-rate samples.

## Self-Check: PASSED

- All 9 claimed source/test files exist.
- All 8 implementation/supporting commits exist.
- No owned file remains unstaged or uncommitted.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
