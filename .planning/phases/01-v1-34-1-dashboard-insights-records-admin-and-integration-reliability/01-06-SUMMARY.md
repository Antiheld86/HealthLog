---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "06"
subsystem: pwa
tags: [service-worker, cache-storage, indexeddb, privacy, offline]

requires:
  - phase: 01-02
    provides: RED authenticated-install and session-cache isolation contracts
provides:
  - Public-asset-only service-worker install with no authenticated root precache
  - Same-version root eviction and data-free offline fallback
  - Current and legacy HealthLog static/page/data cache cleanup at session end
  - App-scoped activation cleanup that preserves unrelated CacheStorage namespaces
affects: [SEC-02, SEC-08, pwa, logout, offline]

tech-stack:
  added: []
  patterns:
    - Explicit owned-cache regex shared by service-worker and session cleanup boundaries
    - Same-version legacy-entry removal during service-worker install

key-files:
  created: []
  modified:
    - public/sw.js
    - src/lib/pwa/query-persister.ts

key-decisions:
  - "Precache only immutable public logos/favicon and explicitly delete a root entry left in the same release-scoped cache."
  - "Scope activation and logout deletion to healthlog-{static,pages,data}-* instead of deleting unrelated CacheStorage namespaces."

patterns-established:
  - "PWA cache ownership uses the same anchored HealthLog family matcher at worker activation and client session end."
  - "Session-end cleanup clears IndexedDB query persistence before CacheStorage families on a best-effort basis."

requirements-completed: [SEC-02, SEC-08]

duration: 3min
completed: 2026-07-29
---

# Phase 1 Plan 06: PWA Account-Data Cache Isolation Summary

**Public-only PWA installation, data-free root fallback, and complete app-scoped logout eviction prevent authenticated Dashboard HTML from surviving a session.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-29T11:44:13Z
- **Completed:** 2026-07-29T11:47:13Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Removed `/` from install precaching and evicted same-version root entries left by older worker source, preventing signed-in Dashboard HTML from entering the static cache.
- Preserved the inline locale-neutral, data-free offline document and immutable public logo/favicon support.
- Expanded logout cleanup across every current and legacy HealthLog static/page/data cache while keeping unrelated cache namespaces intact.
- Narrowed service-worker activation cleanup to owned HealthLog cache families rather than deleting every non-current cache on the origin.

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace authenticated root precache with a data-free offline shell** - `885156965` (fix)
2. **Task 2: Purge all current and legacy HealthLog caches on logout** - `338dbe6c1` (fix)

## Files Created/Modified

- `public/sw.js` - Public-only precache list, same-version root eviction, and app-scoped stale-cache activation cleanup.
- `src/lib/pwa/query-persister.ts` - Session-end deletion of all owned static/page/data cache versions alongside the IndexedDB query snapshot.

## Decisions Made

- Kept normal online navigation and the existing `Cache-Control: no-store` privacy gate intact; the reported leak was the credential-bearing install fetch of `/`.
- Used the anchored `^healthlog-(?:static|pages|data)-` ownership contract in both runtimes, covering documented historical names without an indiscriminate browser-wide purge.
- Preserved all existing public/offline behavior and added no dependency, schema, migration, package, lockfile, or workspace changes.

## Verification

- Plan 01-06 focused gate: **42/42 passed** across service-worker VM, source hardening, and query-persister tests.
- Positive controls: **52/52 passed** when including logout/session-expiry hook integration suites.
- Prettier passed for both owned production files.
- The former Plan 01-02 RED failures are green: no signed-in root request/storage/replay, static caches are included in current/legacy logout cleanup, and unrelated sentinel caches survive.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-02 is closed at install, offline navigation, activation, logout, and persisted-query boundaries.
- The merged security gate can use the Plan 01-02 tests as final-boundary positive/negative evidence.

## Self-Check: PASSED

Both owned production files and this summary exist. Task commits `885156965` and `338dbe6c1` are present in repository history.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
