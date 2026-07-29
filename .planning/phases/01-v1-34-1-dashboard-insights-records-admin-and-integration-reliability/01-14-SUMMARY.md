---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "14"
subsystem: testing
tags: [jobs, cohorts, google-health, withings, telemetry, privacy, tdd]

requires:
  - phase: 01-09
    provides: Focused security gate before reliability contract work
provides:
  - RED Google Health and Withings per-user verdict aggregation contracts
  - RED bounded privacy-safe job outcome serialization contracts
affects: [01-22, job-outcomes, integration-cohorts, worker-telemetry]

tech-stack:
  added: []
  patterns:
    - Provider-neutral per-user verdict folding into fixed aggregate counters
    - Explicit serialization boundary between internal job causes and emitted job facts

key-files:
  created:
    - src/lib/jobs/reminder/__tests__/integration-cohort-outcomes.test.ts
    - src/lib/jobs/__tests__/job-outcome.test.ts
  modified: []

key-decisions:
  - "users_synced counts only complete users; partial, failed, parked, and skipped users retain separate counters."
  - "A complete zero-write run is clean_zero, while complete or partial raw writes are useful work."
  - "Job output serialization uses a fixed fact-key allowlist, stable short codes, safe non-negative integer counts, and a 2 KiB ceiling."

patterns-established:
  - "Cohort privacy: only fixed aggregate counts and provider/outcome codes leave the fold; per-user objects never do."
  - "Retry truth: a retryable cohort-wide failure remains ok:false, while isolated retryable users are counted without retrying the whole cohort."

requirements-completed: [SYNC-02, JOB-01]

duration: 4min
completed: 2026-07-29
---

# Phase 1 Plan 14: Truthful Cohort and Job Outcome RED Contract Summary

**Google/Withings verdict folding and bounded job serialization pinned against false synced counts and private telemetry**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-29T12:22:40Z
- **Completed:** 2026-07-29T12:26:31Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added table-driven Google Health and Withings contracts for complete, partial, failed, parked, skipped, useful-write, and clean-zero outcomes.
- Required failed, parked, skipped, and partial users to remain outside `users_synced`, with the five exclusive status counters summing to total.
- Pinned rollup/downstream partial failure and retryable-user counts without turning isolated user failure into a cohort-wide queue retry.
- Added fixed-key, scalar-type, count-range, reason-code, fact-count, payload-byte, and privacy-negative serialization tests.
- Directly captured the current Google resolved-failure discard and Withings unconditional `usersSynced++` behavior as RED handler-wiring regressions.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define truthful cohort and high-volume job scalars** - `690c4aeb5` (test, RED)

## Files Created/Modified

- `src/lib/jobs/reminder/__tests__/integration-cohort-outcomes.test.ts` - Provider handler wiring, mixed verdict fold, clean-zero, downstream/retry, high-volume boundedness, and privacy contracts.
- `src/lib/jobs/__tests__/job-outcome.test.ts` - Generic allowlist, scalar validation, stable failure-code, cause-redaction, and serialized-size contracts.

## Decisions Made

- Plan 22 will expose `foldIntegrationCohortOutcomes` from the shared poll-cohort module so Google and Withings cannot drift into separate definitions.
- Complete users with zero imported rows count as synced and clean-zero; partial writes count as useful but not synced.
- The fold emits no per-user reason codes or identifiers. It keeps only fixed counts, a fixed provider code, and a useful/clean-zero outcome code.
- Raw `cause` may remain available internally for retry mechanics, but `serializeJobOutcome` must omit it and emit only a stable `reason_code`.
- Unsafe fact keys, free-text string facts, negative/non-finite/unsafe counts, nested data, and oversized payloads fail closed.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Repository-wide `pnpm typecheck` remains RED only in concurrently authored Google Health contract files for missing Plan 21 implementation and mock tuple typing. No error references either Plan 01-14 file.

## Verification Evidence

- Focused Vitest gate: **expected RED**, 46/46 contracts fail because the verdict fold, handler wiring, allowlist, and serializer do not exist yet.
- Focused ESLint: passed for both owned files.
- Prettier and `git diff --check`: passed for both owned files.
- Gitleaks pre-commit hook: passed.

## User Setup Required

None - this plan adds test contracts only.

## Next Phase Readiness

- Plan 22 has a fixed input/output contract for provider-neutral cohort aggregation.
- The failures are implementation-specific: missing exports and the explicitly detected false-synced handler patterns, not syntax or infrastructure errors.

## Self-Check: PASSED

- Both owned test files exist.
- Task commit `690c4aeb5` exists on the current branch.
- No production, schema, migration, package, scanner, or unrelated test files were changed by Plan 01-14.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
