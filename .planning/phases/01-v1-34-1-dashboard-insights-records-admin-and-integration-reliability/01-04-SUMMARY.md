---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "04"
subsystem: testing
tags: [nightscout, ssrf, exact-origin, operator-policy, vitest]

requires: []
provides:
  - Strict server-only NIGHTSCOUT_PRIVATE_ORIGINS parser and verdict contracts
  - Final-boundary tests denying user-controlled private-host authority
  - Redacted operator-action UI contract for legacy private connections
affects: [01-07-nightscout-security-implementation, 01-09-security-gate]

tech-stack:
  added: []
  patterns:
    - Exact canonical scheme/host/port membership for private egress
    - Stable private_origin_not_approved reason across client, sync, route, and UI

key-files:
  created:
    - src/lib/validations/__tests__/nightscout.test.ts
  modified:
    - src/lib/nightscout/__tests__/client.test.ts
    - src/lib/nightscout/__tests__/sync.test.ts
    - src/app/api/nightscout/connect/__tests__/route.test.ts
    - src/app/api/nightscout/sync/__tests__/route.test.ts
    - src/components/settings/integrations/__tests__/nightscout-card.test.tsx

key-decisions:
  - "Private Nightscout authority is an exact canonical operator-owned origin, never the stored user boolean."
  - "Policy denials use private_origin_not_approved and never expose the raw origin, token, resolver error, or allowlist."
  - "The Wave 0 plan remains test-only; production enforcement belongs to Plan 01-07."

patterns-established:
  - "Two-sided SSRF contracts: public and exact-approved private positives accompany every attacker-negative boundary."
  - "Denied targets stop before the network call; connect-time drift is translated to one redacted reason."

requirements-completed: [SEC-06, SEC-08]

duration: 8 min
completed: 2026-07-29
---

# Phase 1 Plan 04: Nightscout Operator-Origin Red Contract Summary

**A 100-test Nightscout security contract preserves public and exact operator-approved private access while making the user-controlled SSRF bypass and unsafe legacy UI explicitly RED.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-29T11:31:43Z
- **Completed:** 2026-07-29T11:40:22Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Declared strict comma-separated `NIGHTSCOUT_PRIVATE_ORIGINS` parsing, canonicalization, and malformed-entry rejection.
- Pinned connect, client, sync, and manual-sync behavior for public positives, exact private positives, user-boolean attacks, port mismatch, DNS/connect drift, and legacy-row rechecks.
- Specified an accessible breaking-change state that removes the private-host toggle, redacts unsafe details, requests operator action, and preserves healthy connected actions.

## Task Commits

Each task was committed atomically:

1. **Task 1: Specify exact operator-origin configuration** - `668f85a58` (test)
2. **Task 2: Pin connect-time and sync-time egress policy** - `14f451093` (test)
3. **Task 3: Pin the user-facing breaking-change state** - `5569b8259` (test)

## Files Created/Modified

- `src/lib/validations/__tests__/nightscout.test.ts` - Exact origin parser and public/private policy verdict matrix.
- `src/lib/nightscout/__tests__/client.test.ts` - Final fetch denial, exact-private positive, port mismatch, and redacted DNS/connect-drift contracts.
- `src/lib/nightscout/__tests__/sync.test.ts` - Legacy boolean removal and stable persistent policy-failure recording.
- `src/app/api/nightscout/connect/__tests__/route.test.ts` - Persistence-boundary user attack denial and exact operator-private positive.
- `src/app/api/nightscout/sync/__tests__/route.test.ts` - Stable redacted operator-action response for legacy rows.
- `src/components/settings/integrations/__tests__/nightscout-card.test.tsx` - Toggle removal, safe operator guidance, and healthy public/private actions.

## Verification

- Combined six-file Vitest run: **100 discovered, 80 passed, 20 expected RED failures**.
- Validation suite: RED because `parseNightscoutPrivateOrigins` and `evaluateNightscoutOrigin` do not exist yet.
- Client/sync/routes: RED because the stored boolean still grants private access, configured exact origins are not authoritative, port mismatches reach the probe, and policy failures are not yet stable/redacted end to end.
- Settings card: RED because the user toggle still renders and legacy policy failures still expose raw details and unsafe actions.
- Focused Prettier check: passed.
- Focused ESLint over all six owned test files: passed.

## Decisions Made

- The parser throws on any malformed operator trust entry rather than silently broadening or partially accepting the allowlist.
- Default ports are canonicalized through URL-origin semantics; non-default ports remain part of exact membership.
- Compatibility fields may remain readable, but tests forbid forwarding `allowPrivateHost` as egress authority.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Parallel Vitest processes from other disjoint Wave 0 executors contended for workers. Focused verification was rerun serially with `--no-file-parallelism`; contract results were stable.
- The pre-existing package, lockfile, and workspace scanner diff was preserved and not staged.

## Deferred Issues

- The accepted Low Nightscout token-warning log finding remains unresolved by design. No production logging code or claim of remediation was added.

## User Setup Required

None - this Wave 0 plan adds tests only. Operator configuration is implemented and documented by later plans.

## Next Phase Readiness

- Plan 01-07 can implement the exact-origin policy against explicit positive and attacker-negative contracts.
- The focused security gate can use the same six suites after Plan 01-07 turns all 20 policy assertions green.

## Self-Check: PASSED

- All six owned test files and this summary exist.
- Task commits `668f85a58`, `14f451093`, and `5569b8259` are present in repository history.

---

_Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability_
_Completed: 2026-07-29_
