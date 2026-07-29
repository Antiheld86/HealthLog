---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "02"
subsystem: testing
tags: [pwa, cache-storage, ssrf, ipv6, undici, vitest]

requires: []
provides:
  - RED CacheStorage contracts preventing authenticated root HTML from entering the PWA cache
  - RED session-end cleanup contracts covering current and legacy static/page/data caches
  - RED literal and DNS-pinned verdict matrices for standard IPv4-embedded IPv6 forms
affects: [SEC-02, SEC-03, SEC-08, service-worker, safe-fetch]

tech-stack:
  added: []
  patterns:
    - VM service-worker install fixtures with a signed-in health-data sentinel
    - Table-driven transition-prefix cases shared conceptually across literal and connect-time boundaries
    - Real Undici dispatcher failures distinguished by nested ENOTFOUND codes

key-files:
  created: []
  modified:
    - src/__tests__/service-worker.test.ts
    - src/__tests__/sw-security-hardening.test.ts
    - src/lib/pwa/__tests__/query-persister.test.ts
    - src/lib/validations/__tests__/notifications.test.ts
    - src/lib/__tests__/safe-fetch-dispatcher.test.ts
    - src/lib/__tests__/safe-fetch-pinned.test.ts

key-decisions:
  - "Exercise authenticated install at the CacheStorage boundary with a same-origin credential request and a unique health-data sentinel."
  - "Cover only standard mapped, compatible, 6to4, NAT64-WKP, and RFC8215 local-use encodings; do not infer arbitrary operator NAT64 prefixes."
  - "Treat ENOTFOUND from the pinned lookup as the pre-connect refusal signal and retain a real dual-stack/redirect transport control."

patterns-established:
  - "Security RED tests pair attacker-negative cases with explicit legitimate-positive controls."
  - "Dispatcher regressions mock DNS answers, not HTTP response bodies."

requirements-completed: [SEC-02, SEC-03, SEC-08]

duration: 10min
completed: 2026-07-29
---

# Phase 1 Plan 02: PWA Cache and Embedded-IPv4 SSRF RED Contracts Summary

**Final-boundary RED contracts now expose authenticated PWA cache leakage and standard IPv4-embedded IPv6 SSRF bypasses while preserving immutable assets, public address families, dual-stack fallback, and redirect rechecks.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-29T11:31:40Z
- **Completed:** 2026-07-29T11:41:40Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Added a service-worker VM install fixture whose signed-in `/` response contains a unique health sentinel; current code demonstrably stores and serves it offline.
- Added session-end cleanup coverage for current and legacy `healthlog-static-*`, `healthlog-pages-*`, and `healthlog-data-*` caches while preserving unrelated CacheStorage entries.
- Added matching literal URL/raw-IP and DNS-pinned matrices for mapped, compatible, 6to4, NAT64-WKP, and RFC8215 local-use forms, plus real transport controls for public dual-stack fallback and redirect destination rechecks.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin authenticated install, public offline shell, and legacy cache cleanup** - `3a813b51b` (test)
2. **Task 2: Add the canonical IPv6 transition-form classifier matrix** - `fb533147d` (test)
3. **Task 3: Pin the same verdict at the DNS-pinned dispatcher** - `e25080b21` (test)

## Files Created/Modified

- `src/__tests__/service-worker.test.ts` - Signed-in install fixture, cache-content sentinel assertion, and offline-shell boundary.
- `src/__tests__/sw-security-hardening.test.ts` - Source-level invariant that the immutable precache list excludes `/`.
- `src/lib/pwa/__tests__/query-persister.test.ts` - Current/legacy HealthLog cache-family cleanup and unrelated-cache preservation.
- `src/lib/validations/__tests__/notifications.test.ts` - Canonical transition-form literal URL/raw-IP matrix with public and syntax controls.
- `src/lib/__tests__/safe-fetch-dispatcher.test.ts` - Resolver-answer refusal matrix requiring pre-connect `ENOTFOUND`.
- `src/lib/__tests__/safe-fetch-pinned.test.ts` - Real dual-stack fallback and redirect-destination DNS recheck controls.

## Decisions Made

- Kept all work test-only; no production, dependency, lockfile, workspace, schema, or migration changes were made.
- Used the browser-equivalent same-origin credential mode in the service-worker `Cache.addAll` fixture so the root response models an install occurring while signed in.
- Used RFC-defined transition prefixes only, including the RFC 6052 bit placement for the RFC8215 `/48` local-use prefix.

## Verification

Focused six-file gate:

- **Result:** expected RED, exit 1.
- **Tests:** 119 total; 21 intended failures and 98 preserved passes.
- **PWA RED reason:** `/` remains in `PRECACHE_URLS`, so signed-in root HTML enters `healthlog-static-*`, is returned offline instead of the inline 503 shell, and session cleanup omits static caches.
- **Classifier RED reason:** compatible, 6to4, NAT64-WKP, and RFC8215 private embeddings are currently accepted at both URL and raw-IP boundaries; malformed IPv6-shaped raw inputs are also accepted.
- **Dispatcher RED reason:** the same eight embedded-private DNS answers reach socket handling instead of being refused by the pinned lookup with `ENOTFOUND`.

Positive-only gate:

- **Result:** 11 passed, 74 skipped.
- Public immutable-asset support, the data-free fallback source contract, public IPv4/native IPv6/transition forms, real dual-stack fallback, and redirect DNS rechecking remain pinned.

Formatting:

- Prettier check passed for all six owned test files.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The plan's `pnpm test -- <files>` spelling caused the repository test script to begin unrelated suites as well as the requested files. Verification was therefore isolated with `pnpm exec vitest run <files>`; the exact owned-file failures and positive controls are reported above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-02 implementation can remove `/` from install precaching and broaden session-end cleanup across every HealthLog cache version.
- SEC-03 implementation can centralize validated IPv6 parsing and standard embedded-IPv4 extraction in `isPublicIp`; the pinned dispatcher will inherit the corrected verdict.
- These suites are intentionally RED until the corresponding production-fix plans run.

## Self-Check: PASSED

All six owned test files and this summary exist. Task commits `3a813b51b`, `fb533147d`, and `e25080b21` are present in repository history.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
