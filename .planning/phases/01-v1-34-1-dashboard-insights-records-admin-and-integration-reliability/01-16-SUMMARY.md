---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "16"
subsystem: ui
tags: [react, vitest, dashboard, insights, records]

requires:
  - phase: 01-10
    provides: RED presentation and records interaction contracts
provides:
  - Non-redundant dashboard, document-summary, and Health Score presentation
  - Foreground treatment and compact spacing for generated assessment prose
  - Consistent Save and first-entry CTA grammar across Records editors
affects: [01-20, 01-23, dashboard, insights, records]

tech-stack:
  added: []
  patterns:
    - Displayed metric values are not repeated in adjacent generated prose
    - Empty collections expose one first-entry CTA while populated collections expose the standard Add action

key-files:
  created: []
  modified:
    - src/components/daily/today-hero.tsx
    - src/components/documents/document-summary-block.tsx
    - src/components/insights/health-score-card.tsx
    - src/app/insights/medications/page.tsx
    - src/components/insights/mood/mood-better-days.tsx
    - src/components/records/health-profile-facts-manager.tsx
    - src/components/records/allergy-manager.tsx
    - src/components/records/family-history-manager.tsx

key-decisions:
  - "The Today Hero suppresses deterministic score prose while the score is provisional and removes only the sentence that repeats a displayed rounded score."
  - "Health Score retains method version and source provenance while removing repeated method and composition prose."
  - "Records collection Add actions are derived from row presence, leaving a single first-entry CTA in empty states."

patterns-established:
  - "Assessment hierarchy: generated assessment prose uses foreground text and compact vertical rhythm."
  - "Action grammar: editable lifestyle facts consistently use Save; destructive and history controls remain unchanged."

requirements-completed: [DASH-01, DOC-01, INS-01, INS-02, INS-03, INS-04, INS-05, INS-06, INS-07, REC-01, REC-02, REC-03, REC-04, REC-05]

duration: 5min
completed: 2026-07-29
---

# Phase 1 Plan 16: Dashboard, Insight, and Records Presentation Cleanup Summary

**Non-redundant dashboard and insight prose with clearer assessment hierarchy and consistent Records action grammar**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-29T12:25:30Z
- **Completed:** 2026-07-29T12:30:21Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Removed repeated score prose from the Today Hero without fabricating a score while the ring remains provisional.
- Simplified stored document summaries and Health Score presentation while retaining regeneration for absent summaries and preserving score provenance.
- Normalized generated Health Score, medication, and mood assessment prose to foreground text with a tighter vertical rhythm.
- Unified lifestyle fact editing on Save and removed duplicate Add actions from empty allergy and family-history states.
- Kept removal, history, localization, API, and score-engine behavior unchanged.

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove redundant dashboard, document, and Health Score presentation** - `d67b89913` (fix)
2. **Task 2: Normalize assessment foreground and spacing** - `c4ec2d552` (fix)
3. **Task 3: Unify Records Save and CTA grammar** - `431120d55` (fix)

## Files Created/Modified

- `src/components/daily/today-hero.tsx` - Removes the sentence that repeats the displayed score and avoids deterministic score prose during provisional scoring.
- `src/components/documents/document-summary-block.tsx` - Removes regeneration from the stored-summary branch while preserving absent-state generation.
- `src/components/insights/health-score-card.tsx` - Removes redundant notice, method, and composition prose and tightens the assessment stack.
- `src/app/insights/medications/page.tsx` - Promotes generated assessment prose to foreground text with compact spacing.
- `src/components/insights/mood/mood-better-days.tsx` - Promotes generated mood assessment prose to foreground text.
- `src/components/records/health-profile-facts-manager.tsx` - Uses Save consistently for lifestyle fact edits.
- `src/components/records/allergy-manager.tsx` - Shows the normal Add action only after the collection has rows.
- `src/components/records/family-history-manager.tsx` - Shows the normal Add action only after the collection has rows.

## Decisions Made

- Preserve any non-score sentences in the Today Hero generated lead; suppress the lead only when removing the repeated score sentence leaves no content.
- Retain the pure algorithm-notice dismissal helper because its existing contract remains useful, even though the notice is no longer rendered.
- Preserve method version, band selection, delta, pillar, and source provenance while removing only redundant Health Score explanatory prose.
- Base collection CTA visibility on row presence so empty states have exactly one entry point.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added Mood Better Days to foreground normalization**

- **Found during:** Task 2
- **Issue:** The focused assessment-spine contract intentionally covers Mood Better Days, but the plan ownership list omitted its component and no other phase plan owned the change.
- **Fix:** Changed only the generated assessment description from muted foreground to foreground text.
- **Files modified:** `src/components/insights/mood/mood-better-days.tsx`
- **Commit:** `c4ec2d552`

## Issues Encountered

None.

## Verification Evidence

- Full focused Vitest gate: **8 files passed, 65 tests passed**.
- Task 1 Vitest gate: **4 files passed, 40 tests passed**.
- Task 2 Vitest gate: **2 files passed, 20 tests passed**.
- Task 3 Vitest gate: **3 files passed, 12 tests passed**.
- Focused ESLint, Prettier, and `git diff --check`: passed for every owned production file.
- Protected-scope comparison confirmed no Plan 16 changes under `src/app/api`, `messages/en.json`, `messages/de.json`, `src/lib/analytics/score`, or `src/components/insights/insight-status-card.tsx`.

## User Setup Required

None.

## Next Phase Readiness

- The dashboard, document-summary, Health Score, medication, mood, and Records interaction contracts from Plan 10 are green.
- Downstream dashboard and insight integration work can rely on a single presentation hierarchy without changing API or score-engine behavior.

## Self-Check: PASSED

- All eight owned production files and this summary exist.
- Task commits `d67b89913`, `c4ec2d552`, and `431120d55` exist on the current branch.
- Protected API, locale, score-engine, and shared insight-status targets remain unchanged by Plan 01-16.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
