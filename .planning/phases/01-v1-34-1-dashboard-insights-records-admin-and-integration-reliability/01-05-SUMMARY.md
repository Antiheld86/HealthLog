---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "05"
subsystem: auth
tags: [mcp, oauth, bearer-scopes, postgres, prisma, concurrency]

requires:
  - phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
    provides: Plan 01-01 MCP authorization and refresh-race RED contracts
provides:
  - Explicit health:read or wildcard authorization before MCP registration
  - PostgreSQL row-locked refresh-family rotation
  - Transactional JTI advancement, access revocation, and successor insertion
  - Post-commit refresh artifact signing
affects: [SEC-01, SEC-04, SEC-08, MCP OAuth]

tech-stack:
  added: []
  patterns:
    - Canonical MCP read-scope predicate enforced before downstream route gates
    - Prisma interactive transaction with PostgreSQL SELECT FOR UPDATE
    - Transaction-client-capable access-token issuance

key-files:
  created: []
  modified:
    - src/lib/mcp/auth.ts
    - src/lib/mcp/scopes.ts
    - src/app/mcp/route.ts
    - src/lib/mcp/oauth/connections.ts
    - src/app/api/mcp/oauth/token/route.ts
    - src/lib/auth/issue-token.ts

key-decisions:
  - "Return an incremental-consent 401 for a valid bearer lacking health:read, before rate limiting, module lookup, or server construction."
  - "Serialize refresh decisions with SELECT FOR UPDATE and commit replay-family revocation in the same transaction that handles successful successor insertion."
  - "Sign stateless refresh artifacts only after the database transaction commits."

patterns-established:
  - "Write and unrelated bearer scopes never imply MCP read authority."
  - "Database helpers accept the active Prisma transaction client instead of opening nested transactions."

requirements-completed: [SEC-01, SEC-04, SEC-08]

duration: 5min
completed: 2026-07-29
---

# Phase 01 Plan 05: MCP Authorization and Refresh Replay Enforcement Summary

**Explicit MCP health-read authorization and row-locked, rollback-safe OAuth refresh-family rotation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-29T11:46:55Z
- **Completed:** 2026-07-29T11:51:26Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Restricted MCP health capabilities to `health:read` and wildcard tokens, rejecting write-only and unrelated valid bearers before any downstream route work.
- Serialized each refresh family with a PostgreSQL connection-row lock and revoked the family on stale JTI or guarded-update loss.
- Moved JTI advancement, linked-access revocation, and successor access insertion into one Prisma interactive transaction.
- Deferred successor refresh signing until after commit, so rolled-back credentials can never be returned.
- Turned the real-Postgres concurrency regression green while preserving sequential rotation and unrelated-connection usability.

## Task Commits

1. **Task 1: Enforce explicit MCP health-read scope at the final boundary** - `20a6731c8` (fix)
2. **Task 2: Make refresh rotation and successor issuance one transaction** - `db08f6c17` (fix)
3. **Task 3: Prove real-Postgres family revocation under concurrency** - verification-only; covered by `db08f6c17`

## Files Created/Modified

- `src/lib/mcp/scopes.ts` - Canonical explicit read-scope predicate.
- `src/lib/mcp/auth.ts` - Permission-derived `canRead` context.
- `src/app/mcp/route.ts` - Final pre-registration insufficient-scope denial.
- `src/lib/mcp/oauth/connections.ts` - Transaction-client rotation, row lock, and complete CAS/replay revocation.
- `src/app/api/mcp/oauth/token/route.ts` - One refresh transaction and post-commit artifact finalization.
- `src/lib/auth/issue-token.ts` - Optional transaction-client token insertion seam.

## Verification

- MCP auth/scope/route unit bundle: **46/46 passed**.
- Real bearer-to-reader integration: **22/22 passed**.
- OAuth token/connection unit bundle: **23/23 passed**.
- Real PostgreSQL refresh-race plus bearer integration bundle: **24/24 passed**.
- Broader owned-seam unit regression, including native refresh and manual MCP token routes: **90/90 passed**.
- ESLint passed across all six production files.
- Full typecheck was attempted and reached one unrelated concurrent Wave-1 passkey test error at `tests/integration/passkey-register.test.ts:86`; it reported no Plan 01-05 owned-file errors.
- Release branch, scanner binary patch digest, and all immutable package/workspace hashes matched the execution baseline after implementation.

## Decisions Made

- Kept bearer validation centralized and used `canRead` as defense in depth at the route boundary, allowing the response to advertise `health:read` for incremental consent.
- Retained the guarded JTI update after row locking. The lock provides serialization; the guard remains a fail-closed invariant and any zero-count result revokes the family.
- No deadlock or serialization retry was added because the deterministic real-Postgres race passed repeatedly with row locking alone.

## Deviations from Plan

None - the plan was implemented without schema, migration, package, or test changes.

## Issues Encountered

- Full-tree typecheck was temporarily blocked by an unrelated concurrently edited passkey integration fixture. Focused tests and ESLint for every owned file passed.

## User Setup Required

None.

## Next Phase Readiness

- SEC-01 and SEC-04 are closed against helper, final-route, rollback, and real-concurrency contracts.
- The merged security gate can include the Plan 01-01 suites without expected failures.

## Self-Check: PASSED

- All six owned production files and this summary exist.
- Both Plan 01-05 implementation commits exist.
- All focused MCP unit and PostgreSQL integration suites are green.
- Scanner baseline files remain byte-for-byte unchanged.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
