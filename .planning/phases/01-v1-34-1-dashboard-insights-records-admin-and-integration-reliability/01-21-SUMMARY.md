---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "21"
subsystem: integrations
tags: [google-health, postgres, prisma, sync-progress, react-query]

requires:
  - phase: 01-13
    provides: Google Health sync correctness baseline and real-account evidence contract
  - phase: 01-15
    provides: Centralized cache/query-key invalidation seams
provides:
  - Race-safe bounded current-run progress retained on GoogleHealthConnection
  - Workout-first serial sync orchestration with exact redacted resource outcomes
  - Authenticated subject-only progress status endpoint and timeout recovery UI
  - Post-commit server and browser workout cache invalidation
affects: [google-health, integration-status, manual-sync, settings-integrations]

tech-stack:
  added: []
  patterns:
    - AsyncLocalStorage-scoped per-resource counters
    - Run-ID guarded JSONB current-run progress
    - Terminal-result recovery through authenticated status polling

key-files:
  created:
    - prisma/migrations/0287_google_health_sync_progress/migration.sql
    - src/lib/google-health/sync-progress.ts
    - src/app/api/google-health/sync/status/route.ts
  modified:
    - prisma/schema.prisma
    - src/lib/google-health/client.ts
    - src/lib/google-health/sync.ts
    - src/lib/google-health/sync-core.ts
    - src/lib/google-health/sync-workout.ts
    - src/app/api/google-health/sync/route.ts
    - src/components/settings/integrations/google-health-card.tsx

key-decisions:
  - "Retain only one bounded progress envelope per Google connection; a guarded run ID prevents delayed writers from replacing a newer run."
  - "Treat existing pagination ceilings as truncation only when a next-page cursor remains; the observed 786-page trace is not itself a failure or an invented cap."
  - "Hold the success watermark for write, rollup, partial, and truncated outcomes."

patterns-established:
  - "Resource outcomes expose exactly resource/pages/fetched/mapped/written/status/durationMs/truncated/reasonCode."
  - "Manual-sync timeout recovery reads only the authenticated subject's retained terminal and invalidates consumers only after committed workout work."

requirements-completed: [GH-02, GH-03, GH-04, GH-05, GH-07, SYNC-01, SYNC-03, PERF-01]

duration: 18min
completed: 2026-07-29
---

# Phase 01 Plan 21: Google Sync Fairness and Durable Progress Summary

**Workout-first Google Health sync with run-ID guarded progress, bounded redacted terminal outcomes, and post-commit cache visibility**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-29T12:45:37Z
- **Completed:** 2026-07-29T13:02:48Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Added the sole nullable `sync_progress` JSONB column and a race-safe current-run ledger that replaces older runs, rejects delayed writers, persists stale runs as interrupted, and bounds all retained facts.
- Moved workouts ahead of dense history, instrumented actual pagination/mapping/writes, preserved 786 successful pages as complete evidence, and prevented partial/write/rollup/truncated cycles from advancing the success watermark.
- Made committed workouts immediately visible through server cache invalidation and through browser workout, Dashboard snapshot, analytics, Google Health, and integration-status query invalidation.
- Added an authenticated subject-only status endpoint and card-side terminal polling after an uncertain POST response.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the bounded race-safe current-run progress store** - `5cfcb69ef` (feat)
2. **Task 2: Orchestrate fair outcomes and invalidate server reads post-commit** - `5ec1a3836` (feat)
3. **Task 3: Return and render an honest manual-sync terminal result** - `ba6d06be3` (feat)
4. **Authorized verification fix: Type guarded progress mock calls** - `5bc213c5b` (test)

## Files Created/Modified

- `prisma/schema.prisma` - Maps the nullable Google connection progress JSON.
- `prisma/migrations/0287_google_health_sync_progress/migration.sql` - Adds only `sync_progress JSONB`.
- `src/lib/google-health/sync-progress.ts` - Sanitizes, serializes, guards, reads, and interrupts current-run progress.
- `src/lib/google-health/__tests__/sync-progress.test.ts` - Types the guarded-write mock tuple for full TypeScript verification.
- `src/lib/google-health/client.ts` - Records actual page/fetch facts and existing-cap truncation inside a resource scope.
- `src/lib/google-health/sync.ts` - Runs workout-first resources and returns/persists terminal resource outcomes.
- `src/lib/google-health/sync-core.ts` - Maps fetch/write/rollup failures to stable reason codes and holds failed cycles.
- `src/lib/google-health/sync-workout.ts` - Invalidates server consumers after successful workout persistence.
- `src/app/api/google-health/sync/route.ts` - Returns only sanitized bounded terminal facts.
- `src/app/api/google-health/sync/status/route.ts` - Reads only the authenticated subject's current run.
- `src/components/settings/integrations/google-health-card.tsx` - Recovers uncertain responses and invalidates committed workout consumers.

## Decisions Made

- Used a single retained JSONB envelope rather than history or shared audit/status storage, keeping ownership and cardinality explicit.
- Counted truncation only when an existing walker limit leaves a continuation token; no provider defect or new universal ceiling was inferred from Antonios's trace.
- Kept arrival emission separate from cache invalidation and performed both only after the relevant database write resolved.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved the resolved Google sync verdict in the cohort adapter**

- **Found during:** Task 2 (fair outcome orchestration)
- **Issue:** The legacy `.then(r => r.imported)` adapter discarded the richer resolved verdict contract and kept the shared Plan 14/22 truthfulness gate red.
- **Fix:** Replaced the chained projection with an explicit awaited result while retaining the legacy numeric cohort helper boundary.
- **Files modified:** `src/lib/google-health/sync.ts`
- **Verification:** Plan 14/22 focused cohort gate passes 52/52.
- **Committed in:** `5ec1a3836`

**2. [Authorized scope extension - Test typing] Typed guarded-write mock calls**

- **Found during:** Final verification
- **Issue:** The pre-seeded progress contract passed at runtime but its zero-argument `vi.fn` inference made guarded-write tuple inspection fail full TypeScript checking.
- **Fix:** Declared the mock argument tuple and centralized the runtime assertion that the guarded write exists before inspection.
- **Files modified:** `src/lib/google-health/__tests__/sync-progress.test.ts`
- **Verification:** Focused progress tests pass 4/4 and full `tsc --noEmit` passes.
- **Committed in:** `5bc213c5b`

---

**Total deviations:** 2 (1 auto-fixed bug, 1 explicitly authorized test-only typing correction)
**Impact on plan:** Both fixes preserve behavior and keep production scope inside the declared Google Health files.

## Issues Encountered

- The initial workout cache import used a nonexistent module name; it was corrected to the existing centralized `@/lib/cache/invalidate` seam before Task 2 verification and commit.
- The pre-seeded progress contract initially inferred a zero-argument mock tuple; the explicitly authorized test-only typing correction resolved it without changing runtime behavior.

## Verification

- Prisma schema validation: passed.
- Focused Plan 21 unit/route/card suite: 35/35 passed.
- Fresh real-PostgreSQL progress and workout-terminal suites: 6/6 passed.
- Shared Plan 14/22 cohort outcome suite: 52/52 passed.
- Full TypeScript check: passed.
- `git diff --check`: passed.

## User Setup Required

None - no new external service configuration required.

## Next Phase Readiness

- Plans consuming Google manual-sync results can rely on bounded terminal DTOs and subject-only timeout recovery.
- GH-01 and GH-06 remain reporter/live-account evidence gated as required; this plan does not claim them complete.

## Self-Check: PASSED

- All 10 declared implementation files and the authorized test-only typing file exist.
- Task commits `5cfcb69ef`, `5ec1a3836`, `ba6d06be3`, and `5bc213c5b` exist.
- All plan-specific unit and real-PostgreSQL verification gates pass.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
