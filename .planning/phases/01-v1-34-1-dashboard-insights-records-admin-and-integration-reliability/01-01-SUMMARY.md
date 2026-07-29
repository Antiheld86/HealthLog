---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "01"
subsystem: testing
tags: [mcp, oauth, bearer-scopes, postgres, concurrency, security]

requires: []
provides:
  - Explicit health:read and wildcard MCP positive contracts
  - Final-route denial contracts for unrelated, expired, and revoked bearers
  - Transactional refresh rotation, rollback, and CAS-loss contracts
  - Deterministic real-Postgres concurrent refresh replay regression
affects: [01-05-mcp-security-enforcement, SEC-01, SEC-04, SEC-08]

tech-stack:
  added: []
  patterns:
    - Spy on MCP server construction and reader invocation at the route boundary
    - Hold a PostgreSQL row lock until both refresh contenders reach the database barrier

key-files:
  created:
    - tests/integration/mcp-oauth-refresh-race.test.ts
  modified:
    - src/lib/mcp/__tests__/auth.test.ts
    - src/lib/mcp/__tests__/scopes.test.ts
    - src/app/mcp/__tests__/route.test.ts
    - tests/integration/bearer-scope-enforcement.test.ts
    - src/app/api/mcp/oauth/__tests__/token.test.ts
    - src/lib/mcp/oauth/__tests__/connections.test.ts

key-decisions:
  - "Accept either 401 or 403 for insufficient MCP read scope while requiring denial before rate limiting, module lookup, server construction, or data access."
  - "Use a real PostgreSQL row-lock barrier so both refresh exchanges contend deterministically without mocking or sequentializing the race."

patterns-established:
  - "MCP read authorization tests pair health:read and wildcard positives with unrelated-scope negatives at helper, route, and database-reader boundaries."
  - "Refresh race tests resolve every returned successor through normal bearer/token routes and separately verify cross-connection isolation."

requirements-completed: [SEC-01, SEC-04, SEC-08]

duration: 14min
completed: 2026-07-29
---

# Phase 01 Plan 01: MCP Authorization and Refresh Replay Red Contracts Summary

**Least-privilege MCP read and atomic refresh-family security contracts, including a deterministic real-Postgres replay race**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-29T11:31:22Z
- **Completed:** 2026-07-29T11:44:47Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Pinned `health:read` and wildcard access as positive MCP capability and reader paths while proving write-only, ingest, notification, FHIR, unrelated, expired, and revoked credentials cannot pass.
- Required insufficient-scope denial before rate limiting, module resolution, MCP server construction, or the real lab reader.
- Specified one transaction-client boundary for connection rotation and successor insertion, including CAS-loss family revocation and insertion-failure rollback.
- Reproduced the concurrent refresh vulnerability against real PostgreSQL while preserving a passing sequential rotation and an unrelated connection.

## Task Commits

1. **Task 1: Pin MCP read authorization at the final route and reader boundary** - `6c0f47aca` (test)
2. **Task 2: Specify sequential rotation and replay-family semantics** - `38501f657` (test)
3. **Task 3: Add the real-Postgres concurrent refresh replay regression** - `390c718b7` (test)

Supporting Plan 01-01 commits:

- `51f5f4395` - restored the explicit transaction-client contract after a concurrent HEAD advance
- `0c29e6e6b` - renamed bearer fixture helpers to keep the owned suite lint-clean

## Files Created/Modified

- `src/lib/mcp/__tests__/auth.test.ts` - Explicit read capability matrix on resolved MCP contexts.
- `src/lib/mcp/__tests__/scopes.test.ts` - Canonical read-scope predicate positives and negatives.
- `src/app/mcp/__tests__/route.test.ts` - Registration and reader spies at the final `/mcp` boundary.
- `tests/integration/bearer-scope-enforcement.test.ts` - Real bearer, module, route, and lab-reader enforcement.
- `src/app/api/mcp/oauth/__tests__/token.test.ts` - Transactional successor issuance and rollback contract.
- `src/lib/mcp/oauth/__tests__/connections.test.ts` - Transaction-client and CAS-loser family-revocation contract.
- `tests/integration/mcp-oauth-refresh-race.test.ts` - Real-Postgres sequential and concurrent refresh-family regression.

## Verification

- MCP scope unit/route target: **expected RED**, 17 failures and 29 passes. Failures are limited to implicit read capability and insufficient-scope requests reaching HTTP 200.
- Bearer integration target: **expected RED**, 5 failures and 17 passes. Failures are limited to same-user unrelated scopes reaching the real MCP lab reader; `health:read`, wildcard, expired/revoked denial, REST ownership, and existing bearer positives pass.
- OAuth token/connection target: **expected RED**, 4 failures and 19 passes. Failures are limited to ignored transaction clients, non-transactional successor issuance, missing rollback, and missing CAS-loss family revocation.
- PostgreSQL refresh-race target: **expected RED**, 1 failed and 1 passed test. The race reports four expected soft failures: live access successor, usable refresh successor, null `revokedAt`, and one live linked access row. Sequential rotation and unrelated-connection isolation pass.
- ESLint passed for all seven owned test files.
- Release branch, binary scanner patch digest, and all three immutable working-file hashes matched `01-EXECUTION-BASELINE.md` before and after execution.

## Decisions Made

- Kept the insufficient-scope wire status flexible between 401 and 403 because both are denial semantics allowed by the plan; the strict invariant is that no downstream capability or reader is reached.
- Used PostgreSQL `pg_stat_activity` only to observe two lock waiters; the test does not alter production synchronization and releases contenders via a row lock held by a separate real transaction.

## Deviations from Plan

None - plan executed as test-only RED contracts without production changes.

## Issues Encountered

- The plan's `pnpm test -- <files>` form passes `--` through to Vitest 4 and can select the whole unit suite. Focused evidence was therefore collected with the equivalent direct `pnpm exec vitest run <files>` commands.
- A concurrent Plan 01-02 documentation commit advanced `HEAD` between staging and an amend attempt. Shared history was not rewritten; `51f5f4395` restored the exact Plan 01-01 file content without changing the other agent's summary.

## User Setup Required

None - the existing Testcontainers PostgreSQL harness provides the integration environment.

## Next Phase Readiness

- Plan 01-05 can implement explicit MCP read scope enforcement against the helper, route, and real-reader failures.
- Plan 01-05 can move row locking, JTI validation, family/access revocation, and successor insertion into one transaction until the unit and real-Postgres race contracts turn green.

## Self-Check: PASSED

- All seven owned test files and this summary exist.
- All five Plan 01-01 commits are present in repository history.
- Scanner baseline hashes remain unchanged.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
