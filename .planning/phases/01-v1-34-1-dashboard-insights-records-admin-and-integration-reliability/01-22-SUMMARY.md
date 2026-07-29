---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "22"
subsystem: jobs
tags: [job-outcomes, cohort-folding, google-health, withings, privacy]

requires:
  - phase: 01-14
    provides: RED contracts for truthful cohort outcomes and bounded serialization
provides:
  - Privacy-safe bounded JobOutcome serialization
  - Provider-neutral complete/partial/failed/parked/skipped cohort folding
  - Truthful Google Health and Withings scheduled-job counters
affects: [integration-reliability, job-observability, reminder-workers]

tech-stack:
  added: []
  patterns:
    - Fixed allowlist serialization for durable job facts
    - Typed per-user verdicts folded into bounded cohort counters

key-files:
  created: []
  modified:
    - src/lib/jobs/job-outcome.ts
    - src/lib/jobs/reminder/poll-cohort.ts
    - src/lib/jobs/reminder/google-health-sync.ts
    - src/lib/jobs/reminder/withings-sync.ts

key-decisions:
  - "Only complete users increment users_synced; partial, failed, parked, and skipped users retain distinct counters."
  - "Only complete or partial writes count as useful, while a successful complete zero is counted separately."
  - "Durable job facts accept only allowlisted bounded scalars and stable codes; raw causes remain process-local."

patterns-established:
  - "Cohort truth: classify every user once, then fold verdicts into a fixed 14-key aggregate."
  - "Privacy boundary: reject unknown keys, nested values, unsafe counts, free-form strings, and oversized serialized outcomes."

requirements-completed: [SYNC-02, JOB-01]

duration: 15min
completed: 2026-07-29
---

# Phase 01 Plan 22: Truthful Bounded Cohort Outcomes Summary

**Privacy-safe job serialization and typed Google Health/Withings verdict folding distinguish useful, clean-zero, partial, failed, parked, and skipped work without false synced counts.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-29T12:40:18Z
- **Completed:** 2026-07-29T12:54:55Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments

- Added a fail-closed serializer with an explicit fact allowlist, stable reason codes, non-negative safe-integer counters, and a 2 KiB ceiling.
- Added a fixed-shape provider-neutral fold in which only complete users count as synced and only complete/partial writes count as useful.
- Wired Google Health and all Withings scheduled handlers to classify parked and post-sync reauth states without changing bounded fan-out, retry isolation, or reminder enqueue behavior.
- Removed per-user identifiers and raw thrown values from cohort warning messages.

## Task Commits

Each task was committed atomically:

1. **Task 1: Aggregate truthful bounded cohort and job outcomes** - `6a3861122` (feat)
2. **Task 1 refactor: Reuse the shared Google cohort concurrency limit** - `c3ffc4333` (refactor)

## Files Created/Modified

- `src/lib/jobs/job-outcome.ts` - Validates and serializes bounded privacy-safe job facts.
- `src/lib/jobs/reminder/poll-cohort.ts` - Defines typed user verdicts and the fixed cohort aggregate.
- `src/lib/jobs/reminder/google-health-sync.ts` - Preserves bounded fan-out while folding rich Google sync results.
- `src/lib/jobs/reminder/withings-sync.ts` - Folds fallback, ECG, activity, and sleep results without unconditional synced counts.

## Decisions Made

- A user is synced only after a complete result, including a legitimate clean zero.
- A partial result may be useful when it wrote measurements, but it never increments `users_synced`.
- Reauth is checked both before and after provider work so token failures that park during a run do not masquerade as failures or clean zeros.
- Cohort-wide failures still throw for queue retry, while isolated user failures complete the cohort and remain visible in aggregate counters.
- Per-user reason codes are accepted as internal verdict detail but never serialized into the cohort result.

## Deviations from Plan

None - the implementation followed the planned bounded outcome and cohort-folding contract.

## Issues Encountered

- During isolated Plan 22 execution, the exact focused command initially
  reported 51 passing tests and one static failure in the adjacent
  `src/lib/google-health/sync.ts` adapter. Plan 21 subsequently replaced that
  adapter in commit `5ec1a3836`; the combined Plan 14/22 gate now passes 52/52.
- The concurrent Plan 21 type errors were closed in `5bc213c5b`; the repository
  TypeScript check now passes.
- Targeted ESLint, Prettier, and `git diff --check` pass for all four Plan 22 implementation files.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The bounded outcome contract is ready for operator-surface persistence and display.
- The adjacent Google core adapter now retains its resolved verdict, and the
  merged Plan 21/22 verification is green.

## Self-Check: PASSED

- All four declared implementation files exist.
- Task commits `6a3861122` and `c3ffc4333` exist in repository history.
- Scanner-owned package and workspace hashes remain unchanged on `release/v1.34.1`.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
