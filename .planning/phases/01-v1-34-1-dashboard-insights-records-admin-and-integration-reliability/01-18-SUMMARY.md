---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "18"
subsystem: medication-scheduling
tags: [medications, recurrence, reminders, occurrence-identity, postgres]

requires:
  - phase: 01-11
    provides: RED reminder and rolling-overdue occurrence contracts
provides:
  - Cross-midnight reminder lookup and dedup keyed to the canonical scheduled occurrence
  - Rolling prior-occurrence projection bounded by the existing actionable band
  - Schedule/era-aware exact resolution with retry-safe shared consumer state
affects: [issue-664, medication-reminders, rolling-recurrence, medication-list, dashboard]

tech-stack:
  added: []
  patterns:
    - canonical occurrence identity carries schedule ID plus exact scheduled instant
    - display-band projection is separate from retrospective compliance thresholds
    - server list state prevents client clock-window rebinding

key-files:
  created: []
  modified:
    - src/lib/jobs/reminder/medication-reminder-check.ts
    - src/lib/medications/scheduling/recurrence.ts
    - src/lib/medications/scheduling/next-due.ts
    - src/lib/medications/scheduling/band-minter.ts
    - src/lib/medications/list-read.ts

key-decisions:
  - "Reminder suppression and dedup derive from the selected occurrence local date, never the worker tick date."
  - "Open rolling occurrences opt into display-band minting without changing the half-cycle compliance denominator."
  - "Resolved rolling skips and auto-misses advance on the existing cadence grid without becoming intake anchors."
  - "Existing canonical intake upsert/retry behavior was retained because its real-Postgres controls already passed."

patterns-established:
  - "Occurrence identity: scheduleId + scheduled instant, with action time used for era isolation."
  - "Consumer authority: prior rolling due state is projected once by the server and not reconstructed from today's wall clock."

requirements-completed: [REM-01, REM-02, REM-03, REM-04, REM-05, MED-01, MED-02, MED-03, MED-04, MED-05, MED-06]

duration: 10min
completed: 2026-07-29
---

# Phase 01 Plan 18: Canonical Medication Occurrence Identity Summary

**Canonical schedule-and-instant identity now survives reminder midnight boundaries and keeps unresolved rolling doses visible through their existing actionable band across every medication consumer.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-29T12:27:25Z
- **Completed:** 2026-07-29T12:36:57Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Fixed issue #664’s worker-day mismatch by selecting canonical recurrence occurrences, widening the action lookup only to eligible cross-midnight windows, and deriving dedup/notification metadata from the occurrence itself.
- Removed the rolling post-midnight gap by retaining the prior occurrence identity and opting display-due banding into the open rolling slot without changing weekly clinical windows or compliance’s half-cycle threshold.
- Added schedule and era identity to exact resolved marks, allowing taken/skipped/auto-missed state to suppress one occurrence while sibling schedules, replacement eras, and future grid occurrences remain independent.
- Kept list, Dashboard, GLP-1 card, and take-all on the same persisted occurrence; exact intake, concurrent retries, tombstones, and sibling medications converge without duplicate live rows or false already-taken behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Carry scheduled occurrence identity through reminder lookup and dedup** - `c0af97ce4` (fix)
2. **Task 2: Keep unresolved rolling occurrence through its band** - `2de9bccf9` (fix)
3. **Task 3: Use one due result for reads, projection, and intake** - `840e47fda` (fix)

Supporting cleanup:

- `0ae9165aa` - repository formatting for the occurrence identity changes

## Files Created/Modified

- `src/lib/jobs/reminder/medication-reminder-check.ts` - Selects an active canonical occurrence across midnight and uses its exact instant/date for suppression, dedup, minting, and notification metadata.
- `src/lib/medications/scheduling/recurrence.ts` - Carries schedule identity, retains the immediate rolling occurrence across day changes, and advances resolved rolling grid occurrences.
- `src/lib/medications/scheduling/next-due.ts` - Resolves by schedule/era identity, selects open overdue bands, and rejects closed stale rolling occurrences.
- `src/lib/medications/scheduling/band-minter.ts` - Allows display consumers to include an open rolling occurrence while retrospective compliance retains its existing threshold.
- `src/lib/medications/list-read.ts` - Exposes the due schedule ID and prevents a prior rolling occurrence from being rebound to today’s matching clock window.

## Decisions Made

- A prior reminder occurrence is searched only when its own resolved window crosses into the current local day; ordinary stale yesterday slots do not begin reminding again.
- `Occurrence.scheduleId` is the canonical owner. Optional schedule/action metadata on persisted resolution marks preserves backward compatibility while enabling exact sibling and era isolation where attribution provides identity.
- A skipped or auto-missed rolling occurrence advances to the next cadence-grid occurrence but does not alter `lastIntakeAt`; only a real take re-anchors rolling cadence.
- The existing intake upsert already passed real concurrent/retry and unrelated-row tests, so no route or schema change was warranted.

## Deviations from Plan

None - plan executed within the listed production boundaries. Files whose existing implementation already satisfied the green contract were verified and left unchanged.

## Verification

- **Broad focused unit cluster:** 21 files, 388 tests passed.
  - Includes every scheduling unit suite, reminder worker/dedup, intake route, medication-card next-due, and take-all.
- **Real PostgreSQL regression cluster:** 2 files, 8 tests passed.
  - Cross-midnight reminder: 2/2.
  - Rolling overdue consumers and intake concurrency/isolation: 6/6.
- **ESLint:** Passed for all eight Plan 01-18 production files.
- **Prettier:** Passed for all eight Plan 01-18 production files.
- **TypeScript:** No Plan 01-18 errors. Repository-wide `pnpm typecheck` remains non-zero only because concurrent Google Health RED tests reference `sync-progress` and status-route production modules that have not landed yet.

## Issues Encountered

- Repository-wide type checking is temporarily blocked by concurrent Plan 01-13 Google Health work. The remaining diagnostics are confined to its test files; all occurrence-identity production files are clean.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- REM-01 through REM-04 and MED-01 through MED-06 are technically closed by green unit and real-persistence regressions.
- REM-05 remains the stated release-process constraint: issue #664 should stay open until reporter confirmation.
- No migration, package, client fallback, or clinical band widening was introduced.

## Self-Check: PASSED

- All 6 claimed files exist.
- All 4 implementation/supporting commits exist.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
