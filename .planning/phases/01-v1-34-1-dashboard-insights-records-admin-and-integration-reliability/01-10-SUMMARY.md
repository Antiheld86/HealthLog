---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "10"
subsystem: testing
tags: [vitest, playwright, react, responsive-layout, ai-safety]

requires:
  - phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
    provides: v1.34.1 product intent, UI standards, and test infrastructure
provides:
  - RED component contracts for Dashboard, documents, Health Score, assessments, records, Settings, and Admin
  - RED responsive geometry contracts across desktop, short desktop, tablet, and phone viewports
  - Deterministic release evidence capture points for five named UI surfaces
affects: [01-14, 01-15, 01-20, dashboard, insights, records, navigation]

tech-stack:
  added: []
  patterns:
    - test-only RED presentation contracts with positive preservation assertions
    - route-envelope to hook to card assessment-state coverage
    - deterministic Playwright geometry and evidence capture

key-files:
  created:
    - src/components/records/__tests__/allergy-manager.test.tsx
    - src/components/records/__tests__/family-history-manager.test.tsx
    - e2e/v1341-navigation-and-insights-mobile.spec.ts
    - e2e/v1341-ui-evidence.spec.ts
  modified:
    - src/components/daily/__tests__/today-hero.test.tsx
    - src/components/documents/__tests__/document-summary-block.test.tsx
    - src/components/insights/__tests__/health-score-card.test.tsx
    - src/hooks/__tests__/use-insight-status.test.ts
    - src/components/insights/__tests__/insight-status-card.test.tsx
    - src/app/api/insights/biomarker-assessment/__tests__/route.test.ts
    - src/app/insights/__tests__/assessment-spine-order.test.ts
    - src/components/records/__tests__/health-profile-facts-manager.test.tsx
    - src/components/settings/__tests__/settings-shell.test.tsx
    - src/components/admin/__tests__/admin-shell.test.tsx

key-decisions:
  - "Treat a safe terminal assessment fallback as displayable text even when the envelope has hasProvider:false; a null-text envelope remains the provider-setup branch."
  - "Expose poll exhaustion explicitly and clear the preparing presentation instead of merely stopping the timer."
  - "Measure shell alignment, pinning, scroll ownership, and mobile Insights spacing in the browser rather than relying only on utility-class assertions."

patterns-established:
  - "RED presentation tests pair removed-copy assertions with positive checks for data, provenance, history, and destructive controls that must remain."
  - "Evidence screenshots disable animation, wait for fonts and a visible sentinel, use fixed viewports, and attach the exact captured file to Playwright output."

requirements-completed: [DASH-01, DOC-01, INS-01, INS-02, INS-03, INS-04, INS-05, INS-06, INS-07, INS-08, INS-09, REC-01, REC-02, REC-03, REC-04, REC-05, NAV-01, NAV-02, NAV-03, NAV-04, NAV-05, AI-01, AI-02, AI-03, AI-04, AI-05]

duration: 12min
completed: 2026-07-29
---

# Phase 1 Plan 10: UI Presentation and Navigation RED Contracts Summary

**Vitest and Playwright contracts now isolate the v1.34.1 redundant-copy, assessment-state, record-action, shell-alignment, and mobile Insights spacing defects while preserving safety and data-provenance behavior.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-29T12:11:14Z
- **Completed:** 2026-07-29T12:23:12Z
- **Tasks:** 3
- **Files modified:** 15

## Accomplishments

- Added Dashboard, document-summary, and Health Score RED contracts that reject duplicate or redundant presentation while retaining loaded narrative, score calculation/version, pillar details, and provenance.
- Added assessment route-envelope, bounded-polling, safe-fallback, readable-prose, and stable-state contracts plus record-manager Save/removal/history and empty/populated CTA grammar.
- Added Settings/Admin grouping and pinning contracts, phone Insights gap/focus/touch geometry, and deterministic screenshots for Dashboard, Insights, Anamnesis, Settings, and Admin.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin honest Dashboard, document, and Health Score presentation** - `8e944dbcd` (test)
2. **Task 2: Pin assessment presentation/state honesty and record-management grammar** - `18d0facdf` (test)
3. **Task 3: Define grouped, pinned, responsive navigation geometry** - `65ca1aae4` (test)

## Files Created/Modified

- `src/components/daily/__tests__/today-hero.test.tsx` - useful loaded narrative and non-invented transient score prose.
- `src/components/documents/__tests__/document-summary-block.test.tsx` - stored summaries without regenerate/replacement controls.
- `src/components/insights/__tests__/health-score-card.test.tsx` - one headline score with calculation and provenance preserved.
- `src/hooks/__tests__/use-insight-status.test.ts` - bounded polling must terminate honestly.
- `src/components/insights/__tests__/insight-status-card.test.tsx` - distinct stable states and visible screened fallback.
- `src/app/api/insights/biomarker-assessment/__tests__/route.test.ts` - success, preparing, screened, and negative-cache envelopes.
- `src/app/insights/__tests__/assessment-spine-order.test.ts` - shared compact rhythm and readable assessment prose.
- `src/components/records/__tests__/health-profile-facts-manager.test.tsx` - one Save grammar with removal/history preserved.
- `src/components/records/__tests__/allergy-manager.test.tsx` - exact empty and populated Allergy actions.
- `src/components/records/__tests__/family-history-manager.test.tsx` - exact empty and populated Family history actions.
- `src/components/settings/__tests__/settings-shell.test.tsx` - Settings groups and heading-aligned sticky sidebar.
- `src/components/admin/__tests__/admin-shell.test.tsx` - Admin operational groups, separators, role gate, and sidebar alignment.
- `e2e/v1341-navigation-and-insights-mobile.spec.ts` - desktop/tablet pinning and phone Insights geometry.
- `e2e/v1341-ui-evidence.spec.ts` - five deterministic named screenshot capture points.

## Decisions Made

- The no-provider state is identified by `hasProvider:false` plus no text; safe terminal fallback text must not be discarded solely because its envelope also carries `hasProvider:false`.
- Poll exhaustion is a user-visible terminal condition, so tests require an explicit exhausted signal and a cleared `preparing` presentation.
- The shell contract measures the initial sidebar/heading top, the sidebar after main-content scrolling, document scroll ownership, and width stability.
- Screenshot evidence uses only the seeded E2E account and deterministic route fixtures; no live or personal health data is captured.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The direct Playwright command did not load `.env`, so global setup initially stopped on a missing `DATABASE_URL`. Re-running through Node with `dotenv/config` loaded the standard project environment and exercised the suite.
- The standalone server emitted an encryption-key readiness warning, but the authenticated E2E seed and test run completed. The expected RED browser results were 14 navigation/spacing failures, one evidence test pass, and one project skip.

## Verification

- Combined Vitest contract run: **113 tests, 99 passed, 14 intended RED failures**.
- Playwright contract run on `chromium-desktop` and `chromium-mobile`: **14 intended RED failures, 1 evidence test passed, 1 skipped**.
- Browser measurements reproduced the current defects precisely: Settings/Admin sidebars start **164px** below their headings and the phone Insights row starts **24px** below the main viewport.
- Evidence test generated:
  - `test-results/v1341/dashboard-desktop.png`
  - `test-results/v1341/insights-mobile.png`
  - `test-results/v1341/anamnesis-desktop.png`
  - `test-results/v1341/settings-short-desktop.png`
  - `test-results/v1341/admin-tablet.png`
- ESLint and Prettier passed for all Task 3 files.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Production plans can implement directly against 14 isolated Vitest failures and the measured browser geometry failures.
- Plan 20 owns the shared `InsightStatusCard` and assessment-state seam; the tests intentionally leave production untouched.

## Self-Check: PASSED

- All 14 planned test files exist.
- Task commits `8e944dbcd`, `18d0facdf`, and `65ca1aae4` exist.
- All work remains test-only; no production or locale files were modified.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
