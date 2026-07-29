---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "13"
subsystem: testing
tags: [google-health, vitest, postgres, prisma, cache-invalidation, privacy]

# Dependency graph
requires:
  - phase: 01-09
    provides: immutable baseline and reporter-evidence boundary
provides:
  - RED contracts for workout-first Google Health sync fairness under the observed 786-page heart-rate fixture
  - Bounded per-resource outcomes and race-safe current-run progress contracts
  - Authenticated-subject-only status, timeout polling, and post-commit cache visibility contracts
affects: [01-21, google-health-sync, integration-reliability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - fixed-cardinality redacted per-resource outcome DTOs
    - owner-and-runId guarded current-run progress
    - real-PostgreSQL cache visibility verification

key-files:
  created:
    - src/lib/google-health/__tests__/sync-fairness.test.ts
    - src/lib/google-health/__tests__/sync-outcomes.test.ts
    - src/lib/google-health/__tests__/sync-progress.test.ts
    - tests/integration/google-health-sync-progress.test.ts
    - src/app/api/google-health/sync/status/__tests__/route.test.ts
    - src/components/settings/integrations/__tests__/google-health-card.test.tsx
    - tests/integration/google-health-workout-terminal.test.ts
  modified:
    - src/app/api/google-health/sync/__tests__/route.test.ts

key-decisions:
  - "Model only the observed 786 heart-rate pages and 323.849-second trace; do not infer a provider fault or universal page ceiling."
  - "Keep progress as one nullable owner-scoped current-run envelope with unpredictable runId and fixed bounded resource fields."
  - "Require workout cache visibility and client invalidation only from evidence-backed committed workout writes."

patterns-established:
  - "RED contract isolation: future modules and routes fail specifically as missing while existing route behavior remains green."
  - "Privacy boundary: progress and resource outcomes exclude tokens, URLs, raw errors, health values, and per-sample facts."

requirements-completed: [GH-01, GH-02, GH-03, GH-04, GH-05, GH-06, GH-07, SYNC-01, SYNC-03]

# Metrics
duration: 10min
completed: 2026-07-29
---

# Phase 01 Plan 13: Google Health Reliability RED Contracts Summary

**Workout-first fairness, durable owner-scoped progress, honest terminal recovery, and post-commit cache visibility are pinned as privacy-bounded RED contracts without inventing a reporter cause**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-29T12:13:41Z
- **Completed:** 2026-07-29T12:23:02Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Reproduced starvation with 786 successful dense-heart-rate pages and proved the current ordering reaches workout only after that history.
- Defined the exact nine-field resource outcome DTO plus complete, partial, empty, truncated, collection, token, upsert, and rollup-failure states.
- Pinned owner/run-ID concurrency, newer-run precedence, stale interruption, single-current-run retention, fixed cardinality, and privacy at unit and real-PostgreSQL boundaries.
- Pinned authenticated-subject-only status reads, POST timeout-to-terminal polling, server post-commit visibility, and exact React Query invalidation roots.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin fair ordering and a race-safe bounded current-run ledger** - `d8e52b831` (test)
2. **Task 2: Pin status recovery and post-commit cache visibility** - `6f8462948` (test)

## Files Created/Modified

- `src/lib/google-health/__tests__/sync-fairness.test.ts` - 786-page workout-first scheduling contract.
- `src/lib/google-health/__tests__/sync-outcomes.test.ts` - Exact bounded and redacted resource outcome contracts.
- `src/lib/google-health/__tests__/sync-progress.test.ts` - Current-run ownership, concurrency, staleness, and privacy contracts.
- `tests/integration/google-health-sync-progress.test.ts` - Real-PostgreSQL persistence and race contracts.
- `src/app/api/google-health/sync/__tests__/route.test.ts` - Rich terminal POST response and privacy contracts.
- `src/app/api/google-health/sync/status/__tests__/route.test.ts` - Authenticated-subject-only status route negative cases.
- `src/components/settings/integrations/__tests__/google-health-card.test.tsx` - Timeout polling and exact client invalidation contracts.
- `tests/integration/google-health-workout-terminal.test.ts` - Real-PostgreSQL insert/update cache visibility contracts.
- `.planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-13-SUMMARY.md` - Execution evidence and handoff.

## Verification Evidence

- Task 1 unit group: expected RED, 3 files failed and 6/6 tests failed specifically on workout ordering, absent resource outcomes, and the missing progress module.
- Task 1 real-PostgreSQL group: expected RED, 4/4 tests failed specifically because the planned progress module is absent.
- Task 2 unit/route/card group: expected RED, 6 failed and 5 passed. Failures identify the dropped POST resource verdict, missing status route, absent timeout polling, and absent exact invalidation roots. Existing legacy POST outcomes, secret omission, and the card's owner/query-key negative guard remain green.
- Task 2 real-PostgreSQL group: expected RED, 2/2 tests failed because both inserted and updated committed workouts remain behind the primed server workout cache.
- Prettier and ESLint passed on all eight owned test files.

## Decisions Made

- The fixture records the reporter evidence exactly: 786 heart-rate pages and 323,849 ms. It deliberately sets `truncated: false`; no page cap or provider failure is inferred.
- The storage seam is named `startGoogleHealthSyncProgress`, `updateGoogleHealthSyncProgress`, and `readGoogleHealthSyncProgress`, with user ID plus run ID guarding delayed writers.
- Cache correctness is proven against real PostgreSQL by priming the public cached workout read before insert and update, then requiring the post-sync read to expose committed state.
- GH-01 and GH-06 remain reporter-evidence gated; these RED contracts do not claim the live incident is resolved.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All failures are the intentional implementation gaps required by this RED-only plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 01-21 can implement the named progress seam, status route, fair resource ordering, terminal DTO propagation, and post-commit invalidation without interpreting the reporter trace.
- GH-01/GH-06 stay open until reporter evidence confirms the production symptom.

## Self-Check: PASSED

- All eight owned test files and this summary exist.
- Task commits `d8e52b831` and `6f8462948` exist.
- Branch remains `release/v1.34.1`.
- Scanner-owned package, lock, workspace, and binary-diff hashes exactly match the immutable baseline.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
