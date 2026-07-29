---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "20"
subsystem: insights
tags: [react-query, assessment, safety, cache, polling, accessibility]

requires:
  - phase: 01-10
    provides: RED assessment route, hook, card, and spine contracts
  - phase: 01-16
    provides: Compact foreground assessment presentation
provides:
  - Discriminated generated, fallback, provider, pending, failure, and exhaustion states
  - Fail-closed derived assessment screening with deterministic fallback
  - Explicit generated-cache freshness and negative-cache retry policy
  - Bounded query-identity polling with timeout, error, and exhaustion transitions
  - Shared stable card rendering consumed by metric and slug wrappers
affects: [01-23, assessment-routes, insight-status-workers, metric-pages]

tech-stack:
  added: []
  patterns:
    - Provider availability is metadata and never outranks safe assessment text
    - Poll attempts are bounded per React Query cache identity
    - Provider failures cross the client boundary only as fixed status codes

key-files:
  created: []
  modified:
    - src/lib/insights/status-shared.ts
    - src/lib/insights/status-cache.ts
    - src/lib/insights/derived/derived-assessment-ai.ts
    - src/hooks/use-insight-status.ts
    - src/components/insights/insight-status-card.tsx
    - src/components/insights/metric-status-card.tsx
    - src/components/insights/slug-insight-status-card.tsx

key-decisions:
  - "Use kind as the sole assessment branch discriminator; hasProvider remains provenance metadata."
  - "Keep legacy route scalars during rollout and normalize them once in the shared hook."
  - "Represent generated cache expiry by the user's date key and negative-cache recovery by an explicit retryAt boundary."
  - "Convert request aborts, fetch failures, and poll ceilings to fixed terminal states without carrying raw provider errors."

patterns-established:
  - "Safety fallback: screened, malformed, or ungrounded derived prose is never persisted; the deterministic score assessment remains visible."
  - "Stable assessment geometry: pending, provider setup, failure, exhaustion, empty, and populated branches share gap-2 / py-3 / md:py-4."

requirements-completed: [INS-06, INS-07, INS-08, AI-01, AI-02, AI-03, AI-04, AI-05]

duration: 10min
completed: 2026-07-29
---

# Phase 1 Plan 20: Bounded Fail-Closed Assessment State Summary

**One explicit assessment state machine now preserves safe fallback text, blocks unsafe generated prose, and terminates every polling path**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-29T12:31:57Z
- **Completed:** 2026-07-29T12:41:35Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added a compact discriminated contract for generated, screened fallback, no-provider, preparing, revalidating, timeout, error, and exhausted outcomes.
- Routed derived-score provider prose through the shared fail-closed outbound screen before persistence; blocked, malformed, and ungrounded output now resolves to the safe deterministic assessment.
- Made generated-cache day expiry and negative-cache retry timing explicit without adding provider responses, raw errors, or health values to the envelope.
- Bound polling to each locale/metric query identity, aborted requests on timeout or unmount, and replaced capped preparation with an explicit exhausted terminal state.
- Reordered shared card rendering so safe text remains visible even when `hasProvider` is false, while all non-populated states retain compact stable geometry.
- Updated both shared wrappers to pass the same normalized assessment contract.

## Task Commits

Each task was committed atomically:

1. **Task 1: Classify generated, screened, fallback, and failed outcomes** - `efe203212` (fix)
2. **Task 2: Make assessment polling bounded and terminal** - `33a7dafec` (fix)
3. **Task 3: Render the shared status contract with stable geometry** - `0bf3a3573` (fix)

## Files Created/Modified

- `src/lib/insights/status-shared.ts` - Defines the discriminated state contract, labels finalized summaries, and persists explicit generated-cache policy.
- `src/lib/insights/status-cache.ts` - Exposes generated freshness and privacy-safe negative-cache retry classification.
- `src/lib/insights/derived/derived-assessment-ai.ts` - Screens provider prose and returns explicit safe outcomes without persisting blocked text.
- `src/hooks/use-insight-status.ts` - Normalizes legacy DTOs, bounds fetches and polling, and exposes timeout/error/exhausted terminal states.
- `src/components/insights/insight-status-card.tsx` - Renders state-first branches with safe fallback precedence and stable accessible geometry.
- `src/components/insights/metric-status-card.tsx` - Passes the normalized contract from generic metric queries.
- `src/components/insights/slug-insight-status-card.tsx` - Passes the normalized contract from bespoke metric queries.

## Decisions Made

- Keep the route DTO backward-compatible because API files are outside this plan; the hook enriches it with the shared discriminator.
- Treat a legacy `hasProvider:false` payload with non-empty text as a safe deterministic fallback, not as permission to hide the text behind setup guidance.
- Count attempts from React Query's cache state so locale and metric query keys naturally isolate exhaustion.
- Return fixed timeout/error states from fetch failures and discard exception details at the boundary.
- Preserve stale text during revalidation until it resolves or exhausts; exhaustion becomes terminal rather than retaining preparation flags.

## Deviations from Plan

None - plan executed within the seven-file production ownership boundary.

## Issues Encountered

- Repository-wide `pnpm typecheck` is blocked by concurrent, unowned Google Health RED-contract files: missing `src/app/api/google-health/sync/status/route.ts`, missing `src/lib/google-health/sync-progress.ts`, and associated mock tuple narrowing errors. No diagnostic references a Plan 01-20 file.

## Verification Evidence

- Combined generator/cache/screen/hook/card/route/spine Vitest gate: **9 files passed, 112 tests passed**.
- Task 1 Vitest gate: **3 files passed, 49 tests passed**.
- Task 2 Vitest gate: **1 file passed, 7 tests passed**.
- Task 3 card/hook gate: **3 files passed, 21 tests passed**.
- Biomarker route and assessment-spine reproduction: **2 files passed, 19 tests passed**.
- Focused ESLint, Prettier, and `git diff --check`: passed for all seven owned production files.
- Repository typecheck was attempted and produced only the concurrent Google Health contract diagnostics listed above.
- No locale JSON, API route, feature gate, or health-log implementation was changed.

## User Setup Required

None.

## Next Phase Readiness

- Plan 10 assessment route-hook-card and spine contracts are green.
- Downstream integration work can consume a stable state contract without weakening safety gates or depending on raw provider failures.

## Self-Check: PASSED

- All seven owned production files and this summary exist.
- Task commits `efe203212`, `33a7dafec`, and `0bf3a3573` exist on the current branch.
- Locale catalogs, API routes, and the feature-flag hook remain unchanged by Plan 01-20.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
