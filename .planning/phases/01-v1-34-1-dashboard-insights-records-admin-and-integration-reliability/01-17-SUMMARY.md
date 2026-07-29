---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "17"
subsystem: ui
tags: [navigation, responsive-layout, accessibility, playwright, tailwind]

# Dependency graph
requires:
  - phase: 01-10
    provides: responsive shell component and Playwright geometry contracts
provides:
  - fail-closed grouped Admin navigation with empty-group omission
  - heading-aligned sticky Settings and Admin desktop sidebars
  - gap-free mobile Insights pill mount with preserved focus and touch geometry
affects: [navigation, settings, admin, insights, responsive-shells]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - filter authorized navigation items before deriving group boundaries
    - one main vertical scroll owner with bounded sticky sidebar content
    - route-scoped inherited-spacing removal without negative margins

key-files:
  created: []
  modified:
    - src/components/admin/admin-shell.tsx
    - src/components/settings/settings-shell.tsx
    - src/components/insights/insights-layout-shell.tsx

key-decisions:
  - "Reuse existing Settings group translations for Admin headings rather than add locale keys."
  - "Keep AuthShell as the only page scroll owner and cap sidebar height against the existing 10.5rem shell budget."
  - "Remove only the inherited mobile Insights top padding through a route-scoped parent selector; retain horizontal and safe-area-aware bottom padding."

patterns-established:
  - "Grouped navigation: render headings and separators from the already-filtered visible destination list."
  - "Responsive heading semantics: expose one visible level-one heading per breakpoint without duplicate native h1 geometry."

requirements-completed: [INS-09, NAV-01, NAV-02, NAV-03, NAV-04, NAV-05]

# Metrics
duration: 13min
completed: 2026-07-29
---

# Phase 01 Plan 17: Stable Grouped Navigation Summary

**Fail-closed grouped Admin navigation, heading-aligned pinned desktop sidebars, and a gap-free accessible mobile Insights pill row verified across both Chromium projects**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-29T12:25:41Z
- **Completed:** 2026-07-29T12:38:43Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Clustered every existing Admin destination into five meaningful Settings-style groups only after the confirmed-Admin gate, with no empty headings and quiet mobile separators.
- Aligned Settings and Admin sidebars with their visible page headings and kept them pinned across desktop, short desktop, and tablet without width movement.
- Preserved AuthShell as the page scroll owner while bounding only long sidebar content on short viewports.
- Removed the duplicated 24px mobile Insights pre-pill spacer without negative margins, preserving safe bounds, focus visibility, and 44px targets.
- Regenerated and attached all five deterministic v1.34.1 UI evidence images.

## Task Commits

Each task was committed atomically:

1. **Task 1: Group Admin navigation after fail-closed gating** - `7396119ec` (feat)
2. **Task 2: Align and pin desktop sidebars with one scroll owner** - `23c738efa` (fix)
3. **Task 3: Remove only the unexplained mobile Insights gap** - `b8260474e` (fix)

## Files Created/Modified

- `src/components/admin/admin-shell.tsx` - Adds gated semantic groups and heading-row sticky sidebar geometry.
- `src/components/settings/settings-shell.tsx` - Aligns the sticky sidebar with the heading and shares the shell height budget.
- `src/components/insights/insights-layout-shell.tsx` - Removes only the inherited mobile pre-pill top spacer.
- `.planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-17-SUMMARY.md` - Execution evidence and handoff.

## Verification Evidence

- `TZ=UTC pnpm exec vitest run src/components/settings/__tests__/settings-shell.test.tsx src/components/admin/__tests__/admin-shell.test.tsx`: 31/31 passed.
- ESLint passed on all three owned production components.
- Explicit desktop/mobile Plan 10 Playwright command: 15 passed, 1 expected skip because deterministic evidence capture runs once on `chromium-desktop`.
- Browser checks passed for Settings and Admin at 1440×900, 1280×600, and 900×700 in both configured projects.
- Mobile Insights passed gap, horizontal bounds, overflow, visible focus, and minimum 44px target assertions.
- Evidence produced exactly:
  - `test-results/v1341/dashboard-desktop.png`
  - `test-results/v1341/insights-mobile.png`
  - `test-results/v1341/anamnesis-desktop.png`
  - `test-results/v1341/settings-short-desktop.png`
  - `test-results/v1341/admin-tablet.png`

## Decisions Made

- Admin keeps the original confirmed-Admin fail-closed boundary. Grouping consumes only that authorized visible list and introduces no new authorization or module predicate.
- Admin group labels reuse existing translated Settings grammar (`System`, `Connectivity`, `AI`, `Account`, and `Your data`), avoiding locale churn.
- Sidebar `max-height` uses the same 10.5rem viewport budget as the shared sub-shell floor. This leaves enough containing-block travel for sticky positioning while constraining a long list only when needed.
- The generic AuthShell `pt-6` is suppressed only when the mobile Insights shell is the direct route child. Horizontal padding and safe-area-aware bottom clearance remain owned by AuthShell.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The repository's direct Playwright command did not load `.env`, and concurrent work repeatedly held the shared Next production-build lock. Verification was run against an isolated current-source Next dev server on port 3017 with the existing seeded database and plain-HTTP cookie override. The server was stopped after the full green run.
- The geometry test's native `h1` selector initially selected a hidden duplicate mobile heading at desktop. Both shells now retain an accessible level-one mobile heading while exposing only the visible desktop heading as the native `h1`, avoiding duplicate native heading geometry and duplicate Settings IDs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Grouping, scroll ownership, sticky geometry, safe mobile spacing, focus, and touch-target behavior are green and ready for release verification.
- No authorization, locale, package, schema, migration, or unrelated application files changed.

## Self-Check: PASSED

- All three owned production files and this summary exist.
- Task commits `7396119ec`, `23c738efa`, and `b8260474e` exist.
- Branch remains `release/v1.34.1`.
- Scanner-owned package, lock, workspace, and binary-diff hashes exactly match the immutable baseline.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
