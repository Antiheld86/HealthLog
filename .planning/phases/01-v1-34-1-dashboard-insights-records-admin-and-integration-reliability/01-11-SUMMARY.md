---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "11"
subsystem: testing
tags: [medications, reminders, recurrence, postgres, vitest, regression]

requires:
  - phase: 01-09
    provides: medication correctness audit and regression-test seams
provides:
  - Independent RED contract for reminder occurrence identity across local midnight
  - Canonical rolling-weekly overdue-band and resolved-state contracts
  - Real-Postgres parity contract for list, Dashboard, GLP-1, take-all, and intake writes
affects: [medication-reminders, rolling-recurrence, medication-consumers, issue-664]

tech-stack:
  added: []
  patterns:
    - deterministic Date clocks across UTC, Berlin DST, and Auckland boundaries
    - real PostgreSQL persistence tests paired with focused unit contracts
    - two-sided RED regressions with explicit passing safety controls

key-files:
  created:
    - tests/integration/medication-reminder-cross-midnight.test.ts
    - tests/integration/medication-rolling-overdue-consumers.test.ts
  modified:
    - src/lib/jobs/__tests__/medication-reminder-check.test.ts
    - src/lib/jobs/__tests__/medication-reminder-dedup.test.ts
    - src/lib/medications/scheduling/__tests__/recurrence.test.ts
    - src/lib/medications/scheduling/__tests__/next-due.test.ts
    - src/app/api/medications/[id]/intake/__tests__/route.test.ts

key-decisions:
  - "Kept issue #664 reminder identity and the rolling Mounjaro overdue defect as separate RED contracts."
  - "Compared canonical occurrence instants at server read and real persistence boundaries instead of adding component fallbacks."
  - "Required passing negative controls for exact taken suppression, next-dose isolation, retries, concurrency, tombstones, and sibling medications."

patterns-established:
  - "Occurrence contract: assertions use the exact scheduledFor instant, not a local date or wall-clock approximation."
  - "RED contract: the intended defect stays failing while adjacent safety behavior must already pass."

requirements-completed: [REM-01, REM-02, REM-03, REM-04, MED-01, MED-02, MED-03, MED-04, MED-05, MED-06]

duration: 14min
completed: 2026-07-29
---

# Phase 01 Plan 11: Medication Occurrence Identity Regressions Summary

**Deterministic unit and real-Postgres RED contracts isolate cross-midnight reminder identity from rolling-weekly overdue projection while preserving exact-suppression and no-duplicate safety controls.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-29T12:11:52Z
- **Completed:** 2026-07-29T12:25:20Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Reproduced issue #664 across UTC, ordinary Berlin time, a Berlin DST boundary, and positive-offset Auckland, including a real reminder worker and push-attempt ledger.
- Pinned the Mounjaro weekly timeline through its canonical overdue band, exact taken/skipped/auto-missed resolution, sibling schedules, and schedule-era isolation.
- Proved the current cross-consumer failure using real PostgreSQL records: list, Dashboard, GLP-1 card derivation, and take-all all lose the same prior-day occurrence.
- Protected both safety directions with passing controls for an exact taken occurrence, the next distinct dose, concurrent/retried writes, tombstoned rows, and sibling medications.

## Task Commits

Each task was committed atomically:

1. **Task 1: Reproduce issue #664 with exact cross-midnight occurrence identity** - `81893ac97` (test)
2. **Task 2: Specify the canonical rolling overdue band** - `d5f473d67` (test)
3. **Task 3: Prove one authoritative result across medication consumers** - `25612294d` (test)

Supporting fixture corrections:

- `958b0e10d` - keep the reminder fixture type-safe
- `34372b57b` - use a canonical medication compliance status

## Files Created/Modified

- `src/lib/jobs/__tests__/medication-reminder-check.test.ts` - Cross-midnight worker dispatch and intake-query identity cases across zones and DST.
- `src/lib/jobs/__tests__/medication-reminder-dedup.test.ts` - Retry/dedup contract keyed to the scheduled occurrence's local date.
- `tests/integration/medication-reminder-cross-midnight.test.ts` - Real-Postgres reminder worker, intake, notification dispatch, and push-ledger regression.
- `src/lib/medications/scheduling/__tests__/recurrence.test.ts` - Prior-day rolling occurrence lookup through ordinary and DST weeks.
- `src/lib/medications/scheduling/__tests__/next-due.test.ts` - Rolling overdue band, exact resolution, sibling schedule, and era isolation.
- `tests/integration/medication-rolling-overdue-consumers.test.ts` - Real list, Dashboard, GLP-1, take-all, concurrency, retry, and unrelated-row contracts.
- `src/app/api/medications/[id]/intake/__tests__/route.test.ts` - Exact live-slot query scope and no-false-prompt positive control.

## Verification Results

The plan intentionally requires non-zero RED-suite exits before implementation begins.

- **Focused unit suites:** 131 tests; 118 passed and 13 expected RED assertions failed.
  - Reminder worker: 5 RED failures (four timezone/DST dispatch cases and the prior-day intake-query lower bound).
  - Reminder dedup: 1 RED failure (untaken overnight occurrence is not dispatched).
  - Rolling recurrence: 2 RED failures (ordinary Berlin and spring-DST prior-day occurrences return `null`).
  - Rolling display due: 5 RED failures (unresolved, skipped, auto-missed, sibling schedule, and archived-era identity).
  - Intake route: all 22 tests passed, including the new exact-slot isolation control.
- **Real-Postgres suites:** 8 tests; 4 passed and 4 expected RED assertions failed.
  - Cross-midnight reminder: untreated retry is RED; exact taken suppression plus next distinct dose passes.
  - Rolling consumers: unresolved, skipped, and auto-missed projection are RED; exact taken advancement, concurrent/retry convergence, and unrelated-row isolation pass.
- **ESLint:** Passed for all seven test files.
- **TypeScript:** Plan-owned files pass type checking. The repository-wide command remains non-zero only because concurrently added Google Health test files reference production modules that have not landed yet.

## Decisions Made

- The reminder bug and rolling-overdue bug share the idea of canonical occurrence identity but retain independent tests, so fixing one cannot falsely close the other.
- Consumer parity is asserted at exact ISO `scheduledFor` instants from production builders and derivations; no UI-only fallback is accepted.
- Resolved-state coverage advances to the next distinct occurrence rather than merely asserting disappearance, preventing a false fix that hides every future dose.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Kept the reminder schedule fixture assignable**
- **Found during:** Task 1
- **Issue:** The fixture inferred `timesOfDay` as an empty tuple-like array and `rrule` as only `null`, so direct replacement failed repository type checking.
- **Fix:** Mutated the existing schedule with `Object.assign` without changing the RED behavior.
- **Files modified:** `src/lib/jobs/__tests__/medication-reminder-dedup.test.ts`
- **Verification:** Focused ESLint passed and the suite executes with the intended assertion failure.
- **Committed in:** `958b0e10d`

**2. [Rule 3 - Blocking] Corrected the resolved compliance fixture value**
- **Found during:** Task 3
- **Issue:** The initial no-longer-overdue fixture used `on_track`, which is not a production `DoseStatus`.
- **Fix:** Used the canonical `upcoming` status so take-all suppression is type-correct.
- **Files modified:** `tests/integration/medication-rolling-overdue-consumers.test.ts`
- **Verification:** Repository type checking reports no Plan 01-11 errors.
- **Committed in:** `34372b57b`

---

**Total deviations:** 2 auto-fixed (2 blocking fixture corrections)
**Impact on plan:** Both corrections only made the planned tests executable and type-correct; test semantics and production scope were unchanged.

## Issues Encountered

- Repository-wide `pnpm typecheck` is currently blocked by concurrent Plan 01-13 Google Health RED tests whose referenced `route` and `sync-progress` production modules do not yet exist. No Plan 01-11 file remains in the error output.
- The integration harness reapplies all migrations for each invocation; tests completed normally against isolated PostgreSQL containers.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Implementation can address reminder-day lookup independently from rolling recurrence projection, using exact persisted occurrence identity in both paths.
- The passing controls are ready to reject duplicate intake rows, broad suppression, false already-taken prompts, and future-dose disappearance.
- No claim is made that issue #664 is resolved; these tests intentionally document the current failures.

## Self-Check: PASSED

- All 8 claimed files exist.
- All 5 task/supporting commits exist.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
