---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "23"
subsystem: internationalization
tags: [i18n, icu, passkeys, nightscout, apple-health, regression-tests]

requires:
  - phase: 01-07
    provides: Nightscout operator-owned private-origin policy
  - phase: 01-08
    provides: Passkey existing-factor step-up flow
  - phase: 01-16
    provides: Final score, documents and records UI cleanup
  - phase: 01-17
    provides: Final settings and administration navigation contracts
  - phase: 01-19
    provides: Apple Health ECG import outcome
  - phase: 01-20
    provides: Assessment terminal-state contracts
  - phase: 01-21
    provides: Google Health per-resource terminal outcomes
  - phase: 01-22
    provides: Cohort outcome contracts
  - phase: 01-26
    provides: Final workout pulse behavior
provides:
  - Six-locale parity for final v1.34.1 security, integration, import and terminal-state copy
  - Localized passkey step-up, Nightscout operator action and Apple ECG import outcomes
  - Explicit regression contract for required, ICU-compatible and intentionally removed locale keys
affects: [settings, security, integrations, imports, insights, records, navigation]

tech-stack:
  added: []
  patterns:
    - literal t() call-site inventory for newly introduced release copy
    - targeted required/absent locale contracts with ICU placeholder parity

key-files:
  created:
    - src/__tests__/v1341-locale-parity.test.ts
  modified:
    - messages/en.json
    - messages/de.json
    - messages/es.json
    - messages/fr.json
    - messages/it.json
    - messages/pl.json
    - src/components/settings/security-section/passkey-list-section.tsx
    - src/components/settings/integrations/nightscout-card.tsx
    - src/components/settings/import-panel/apple-health-import-card.tsx
    - src/lib/__tests__/i18n-locale-integrity.test.ts

key-decisions:
  - "Only keys proven unreferenced after final implementation inventory were removed."
  - "Temporary English literals were wired through explicit literal t() calls so repository reverse and call-site coverage can enforce them."
  - "Apple ECG outcome counts use one ICU message with identical placeholders across all six locales."

patterns-established:
  - "Release locale reconciliation: inventory final call sites first, then serialize all catalog edits."
  - "Obsolete-key tests pin intentional removals alongside required-key and placeholder parity."

requirements-completed: [SEC-05, SEC-06, INS-01, INS-02, INS-03, INS-06, INS-07, INS-08, INS-09, HK-07, REC-01, REC-03, REC-04, NAV-01, GH-03, GH-04, GH-07, SYNC-02, JOB-01, AI-04]

duration: 7min
completed: 2026-07-29
---

# Phase 01 Plan 23: v1.34.1 Locale Reconciliation Summary

**All final v1.34.1 security, Nightscout, Apple ECG and terminal-state contracts now resolve naturally in English, German, Spanish, French, Italian and Polish, with obsolete UI copy removed and guarded.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-29T13:06:30+02:00
- **Completed:** 2026-07-29T13:13:30+02:00
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Added natural six-locale copy for passkey step-up verification, Nightscout operator approval and the complete Apple ECG import outcome.
- Replaced the last temporary English literals in those final components without changing behavior or layout.
- Removed only eight proven-obsolete keys: four superseded Health Score explanations, document-summary regeneration, lifestyle correction and the two user-controlled private-Nightscout override strings.
- Added a focused release guard for literal call sites, required keys, intentional absence and ICU placeholder equivalence.
- Reconciled the pre-existing Health Score integrity test with the intentionally retained transparency surface.

## Task Commits

Each task was committed atomically:

1. **Task 1: Inventory final call sites and obsolete copy** - `b6dfe62c9`
2. **Authorized final call-site wiring** - `67eeefd58`
3. **Task 2: Reconcile English, German and Spanish** - `163aa73e0`
4. **Task 3: Complete French, Italian and Polish and all guards** - `b41b32d47`

## Files Created/Modified

- `src/__tests__/v1341-locale-parity.test.ts` - Pins literal final call sites, six-locale required/absent contracts and ICU placeholder parity.
- `messages/{en,de,es,fr,it,pl}.json` - Adds final localized contracts and removes the eight obsolete leaves with identical structure.
- `src/components/settings/security-section/passkey-list-section.tsx` - Translates the passkey existing-factor dialog.
- `src/components/settings/integrations/nightscout-card.tsx` - Translates the operator-owned private-origin action state.
- `src/components/settings/import-panel/apple-health-import-card.tsx` - Renders the ECG terminal summary through one ICU message.
- `src/lib/__tests__/i18n-locale-integrity.test.ts` - Pins only the Health Score transparency copy intentionally retained after UI cleanup.

## Decisions Made

- Retained all existing generic assessment, Google Health, cohort, records and navigation translations because their final call sites reuse valid established keys.
- Kept the Nightscout English wording already covered by the component regression and translated its meaning naturally in each other locale.
- Used one ECG sentence per locale rather than concatenated fragments so grammar and word order remain natural while all five counters retain exact ICU parity.
- Did not remove similarly named keys in other namespaces, such as Coach retry, recovery-code regeneration or record composition, because those remain referenced.

## Deviations from Plan

### Authorized Scope Extensions

**1. Final call-site localization**

- **Found during:** Task 1 final inventory
- **Issue:** Three completed implementation owners still contained temporary English literals, so catalog-only work could not satisfy the release contract.
- **Fix:** With explicit parent authorization, changed exactly the passkey, Nightscout and Apple import call-site files to use `t(...)`; behavior and layout were untouched.
- **Verification:** Literal call-site guard, affected component tests, ESLint, Prettier and TypeScript passed.
- **Committed in:** `67eeefd58`

**2. Stale Health Score locale-integrity expectation**

- **Found during:** Task 3 full locale integrity gate
- **Issue:** The existing integrity test still required three keys the final UI intentionally removed.
- **Fix:** With explicit parent authorization, updated only that key list to the retained Health Score transparency contracts.
- **Verification:** Full locale integrity and English-leak guards passed.
- **Committed in:** `b41b32d47`

---

**Total deviations:** 2 authorized, narrowly scoped corrections.
**Impact on plan:** Both were necessary to make the planned final call-site inventory and repository gates truthful; neither changes product behavior, schema, packages or security boundaries.

## Verification

- **Plan regression cluster:** 9 files, 470 tests passed.
- **Locale integrity and English-leak guards:** 2 files, 30 tests passed.
- **JSON parse:** All six catalogs passed.
- **ESLint:** Passed for all owned and explicitly authorized TypeScript/TSX files.
- **Prettier:** Passed for all six catalogs, both locale tests and all three localized components.
- **TypeScript:** Repository-wide `pnpm exec tsc --noEmit` passed.
- **Diff check:** Passed for all Plan 01-23 files.

## Issues Encountered

- The first call-site assertion did not accept a formatted multiline `t(...)` call. The guard was corrected to permit whitespace after `t(` while still requiring a literal key.
- The Nightscout component regression pinned the original English operator wording. The English catalog retained that established wording; translated catalogs remain natural.

## User Setup Required

None.

## Next Phase Readiness

- The final v1.34.1 locale surface is synchronized across all six supported languages.
- Release-wide quality gates can now run without orphaned Score/UI copy or temporary English-only states from the completed call-site owners.
- No schema, migration, dependency, package or scanner file was changed by this plan.

## Self-Check: PASSED

- All 11 claimed source/test/catalog files exist.
- All 4 implementation/test commits exist.
- No owned Plan 01-23 file remains unstaged or uncommitted.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
