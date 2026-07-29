---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "07"
subsystem: security
tags: [ssrf, ipv6, dns-pinning, nightscout, nextjs]

requires:
  - phase: 01-02
    provides: SSRF classifier and connect-time pinned dispatcher regression matrix
  - phase: 01-04
    provides: Nightscout route, client, sync, persistence, and UI security contracts
provides:
  - Byte-normalized IPv6 transition classification for embedded special-use IPv4
  - Exact server-owned Nightscout private-origin authorization
  - Stable redacted Nightscout policy failures from client through UI
affects: [outbound-http, integrations, notifications, nightscout]

tech-stack:
  added: []
  patterns:
    - Byte-level IP classification shared by literal validation and DNS lookup policy
    - Exact canonical origin grants sourced only from server environment

key-files:
  created: []
  modified:
    - src/lib/validations/notifications.ts
    - src/lib/safe-fetch-dispatcher.ts
    - src/lib/validations/nightscout.ts
    - src/app/api/nightscout/connect/route.ts
    - src/app/api/nightscout/sync/route.ts
    - src/lib/nightscout/client.ts
    - src/lib/nightscout/credentials.ts
    - src/lib/nightscout/sync.ts
    - src/components/settings/integrations/nightscout-card.tsx

key-decisions:
  - "Treat mapped, compatible, 6to4, NAT64 WKP, and RFC8215 local-use IPv6 embeddings according to their extracted IPv4 bytes."
  - "Authorize private Nightscout egress only through exact canonical NIGHTSCOUT_PRIVATE_ORIGINS membership; retain the stored boolean as non-authoritative compatibility metadata."
  - "Represent denied private origins with the stable private_origin_not_approved code and redact all URL/token detail at API, persistence, and UI boundaries."

patterns-established:
  - "Operator-owned egress policy: request fields and stored user preferences never grant private-network authority."
  - "Policy failure propagation: stable reason codes cross internal boundaries while user-facing copy remains redacted."

requirements-completed: [SEC-03, SEC-06, SEC-08]

duration: 14min
completed: 2026-07-29
---

# Phase 1 Plan 07: IPv6 SSRF and Nightscout Origin Policy Summary

**Byte-normalized IPv6 SSRF defenses and exact operator-owned Nightscout origins enforced across connect, sync, persistence, and UI**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-29T11:44:25Z
- **Completed:** 2026-07-29T11:58:32Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Classified private and special-use IPv4 embedded in mapped, compatible, 6to4, NAT64 WKP, and RFC8215 local-use IPv6 forms for both literal validation and resolved DNS answers.
- Replaced Nightscout's user-controlled private-host opt-in with exact normalized origins from the server-owned `NIGHTSCOUT_PRIVATE_ORIGINS` setting, re-evaluated on every fetch.
- Propagated a stable, non-secret `private_origin_not_approved` failure through connect, sync, persistence, and a redacted operator-action UI state while preserving public and approved-private success paths.
- Passed the combined Plan 02 and Plan 04 security gate: 9 test files and 177 tests, plus the repository TypeScript check.

## Task Commits

Each task was committed atomically:

1. **Task 1: Reject private embedded IPv4 across IPv6 transition formats** - `a17786960` (fix)
2. **Task 2: Enforce exact operator-owned Nightscout origins end to end** - `f95da50ba` (fix)
3. **Task 3: Present the server-authoritative Nightscout policy safely** - `27a3e0843` (fix)

## Files Created/Modified

- `src/lib/validations/notifications.ts` - Normalizes IPv6 bytes and rejects special-use embedded IPv4 destinations.
- `src/lib/safe-fetch-dispatcher.ts` - Applies public or exact-operator lookup policy at socket resolution and keeps dispatcher caches isolated.
- `src/lib/validations/nightscout.ts` - Parses and evaluates exact canonical server-owned private origins.
- `src/app/api/nightscout/connect/route.ts` - Ignores user authority flags, enforces server policy, and persists only validated connection metadata.
- `src/app/api/nightscout/sync/route.ts` - Maps the stable private-origin policy failure to an actionable 422 response.
- `src/lib/nightscout/client.ts` - Re-evaluates origin policy for every request and prevents denied requests before network access.
- `src/lib/nightscout/credentials.ts` - Marks the stored private-host boolean as compatibility/display metadata.
- `src/lib/nightscout/sync.ts` - Removes stored-boolean authority and records stable redacted persistent policy failures.
- `src/components/settings/integrations/nightscout-card.tsx` - Removes the bypass control and presents a safe operator-action state.

## Decisions Made

- Used byte-level IP classification rather than hostname text so literal and DNS-resolved transition forms share one verdict.
- Exact operator membership wins for an approved origin; same-host port/scheme variants and hostname suffixes are explicitly denied before the public fallback.
- Kept the legacy request/schema and stored boolean readable for compatibility, but the route and client ignore it as network authority.
- Kept redirects manual and public resolution pinned; operator-approved private origins are re-authorized by exact origin on every request.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added the final Nightscout sync API policy boundary**

- **Found during:** Task 2 (Enforce exact operator-owned Nightscout origins end to end)
- **Issue:** The Plan 04 contract requires `private_origin_not_approved` to remain stable through the manual sync API, but `src/app/api/nightscout/sync/route.ts` was not listed in Plan 07's files.
- **Fix:** With explicit orchestrator authorization, added one narrow error arm mapping only that policy reason to HTTP 422 plus the stable error code; all other upstream failures retain their existing 502 response.
- **Files modified:** `src/app/api/nightscout/sync/route.ts`
- **Verification:** The focused sync route suite and combined 177-test security gate pass.
- **Committed in:** `f95da50ba`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The scoped boundary change was necessary to satisfy the existing end-to-end stable-error contract and introduced no unrelated cleanup.

## Issues Encountered

- Undici rejects port 9 before DNS lookup, so the Plan 02 transition harness was independently corrected by its owning plan to use a high non-blocked port. Plan 07 then passed the corrected DNS/pinning suite without changing that test.
- A hostname under an approved private DNS name could otherwise reach the generic public-host fallback. Exact-origin evaluation now denies same-host and suffix variants before that fallback.

## User Setup Required

Public Nightscout origins require no setup. Operators who intentionally connect to a private Nightscout instance must set `NIGHTSCOUT_PRIVATE_ORIGINS` to a comma-separated list of exact `http(s)://host:port` origins.

## Next Phase Readiness

- Generic outbound validation and Nightscout share regression coverage for literal, DNS, redirect, rebinding, exact-origin, persistence, and UI boundaries.
- No known blockers remain for dependent integration-security work.

## Self-Check: PASSED

- All nine modified production files exist.
- Task commits `a17786960`, `f95da50ba`, and `27a3e0843` exist on the current branch.
- Combined Plan 02 + Plan 04 security tests pass: 177/177.
- `pnpm typecheck` passes.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
