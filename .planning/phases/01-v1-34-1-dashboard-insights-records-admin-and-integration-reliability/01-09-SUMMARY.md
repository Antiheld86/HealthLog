---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "09"
subsystem: security
tags: [vitest, postgresql, mcp, nightscout, passkeys, recovery]

requires:
  - phase: 01-05
    provides: explicit MCP read authorization and refresh-family serialization
  - phase: 01-06
    provides: public-only PWA caching and logout cleanup
  - phase: 01-07
    provides: embedded-private IP rejection and operator-owned Nightscout origins
  - phase: 01-08
    provides: passkey reauthentication and atomic operator reset revocation
provides:
  - Green final-boundary security evidence for SEC-01 through SEC-08
  - Operator upgrade guides for MCP scopes, Nightscout egress, and account recovery
  - Immutable scanner baseline and post-security scope freeze
affects: [plans-10-24, release-gate, self-hosting, security-operations]

tech-stack:
  added: []
  patterns:
    - Direct Vitest file selection without a standalone argument separator
    - Exact operator-owned origin allowlists with pinned outbound resolution

key-files:
  created:
    - docs/integrations/nightscout.md
    - docs/ops/security-recovery.md
    - .planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-SECURITY-FOCUSED-GATE.md
  modified:
    - docs/self-hosting/mcp.md

key-decisions:
  - "Use direct Vitest file arguments as the authoritative focused gate because a standalone -- selects the full configured catalog under Vitest 4.1.5."
  - "Preserve the user-owned Codex Security package/workspace diff byte-for-byte and defer accepted Low findings, dependency reconciliation, and the final standard scan."

patterns-established:
  - "Security gates record legitimate-positive and attacker-negative evidence at final route, cache, network, and database boundaries."
  - "Operator documentation treats private egress and credential recovery as server-owned security policy, never user-controlled bypasses."

requirements-completed: [SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08]

duration: 11min
completed: 2026-07-29
---

# Phase 01 Plan 09: Focused Security Gate Summary

**Zero-skip security boundary evidence across 305 unit/component and 46 real-PostgreSQL tests, with explicit operator contracts and a byte-exact scanner scope freeze**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-29T12:01:29Z
- **Completed:** 2026-07-29T12:12:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Closed SEC-01 through SEC-08 with 20/20 unit-component files and 5/5
  PostgreSQL files passing: 351 tests, zero failures, and zero skips.
- Passed repository typecheck and the revised plan's exact 19-path ESLint
  allowlist with zero errors; four pre-existing unused-parameter warnings in
  the pinned-fetch test fixture were recorded without out-of-scope edits.
- Documented MCP `health:read` isolation, the breaking exact-origin
  `NIGHTSCOUT_PRIVATE_ORIGINS` policy with DNS pinning, and rollback-safe
  all-access-path operator recovery.
- Recomputed the immutable branch, binary-diff digest, and three scanner
  working-file hashes and preserved each value exactly.

## Task Commits

Each task was committed atomically:

1. **Task 1: Run the focused final-boundary security gate** -
   `240918358`, corrected by `56c20f26d` (test/docs)
2. **Task 2: Document the changed security contracts for operators** -
   `9ea0cb867` (docs)
3. **Task 3: Freeze security scope before product work** -
   `fb95e3a13` (docs)

## Files Created/Modified

- `01-SECURITY-FOCUSED-GATE.md` - Commands, counts, SEC-01–08 boundary
  matrix, corrected-command audit trail, hashes, and scope freeze.
- `docs/self-hosting/mcp.md` - Explicit MCP read-scope and upgrade contract.
- `docs/integrations/nightscout.md` - Exact private-origin policy, pinned
  resolution, safe examples, and upgrade checklist.
- `docs/ops/security-recovery.md` - Credential-family revocation and
  transaction rollback behavior.
- `01-09-SUMMARY.md` - Plan execution record.

## Decisions Made

- The corrected direct Vitest commands in the revised Plan 01-09 are the
  authoritative focused gate. The original package-script forwarding failure
  remains in the gate report as an audit trail.
- No source correction was made for the unrelated reverse-i18n orphan keys;
  locale reconciliation remains owned by Plan 23.
- No security-remediation migration, dependency upgrade, Deep scan, or Low
  finding change was permitted at this gate.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected focused Vitest command selection**

- **Found during:** Task 1
- **Issue:** The original `pnpm test -- <files>` and
  `pnpm test:integration -- <files>` forms selected the full configured
  catalogs under Vitest 4.1.5. The broad unit run produced 18,905 passes, one
  unrelated reverse-i18n failure, and 12 unrelated skips.
- **Fix:** The planner revised Plan 01-09 to direct
  `pnpm exec vitest run` commands, including the explicit integration config.
  The already-run direct commands exactly match the revision.
- **Files modified:** `01-09-PLAN.md` by the orchestrator; no package script or
  security source was changed by this executor.
- **Verification:** 305/305 focused unit-component tests and 46/46 focused
  PostgreSQL tests passed with zero skips.
- **Committed in:** `56c20f26d` records the corrected final verdict.

---

**Total deviations:** 1 auto-fixed blocking command-selection issue
**Impact on plan:** The correction narrowed execution to the intended security
files without changing product behavior or release scope.

## Issues Encountered

- The unintended broad unit run exposed two locale keys without call sites.
  This is unrelated to Plans 01-05 through 01-08 and remains assigned to the
  planned locale reconciliation.
- Exact ESLint reports four warnings, but zero errors, in the existing
  `safe-fetch-pinned` test fixture.

## User Setup Required

- Operators with private Nightscout instances must configure exact
  `NIGHTSCOUT_PRIVATE_ORIGINS` entries before upgrading.
- Existing MCP connectors must use `health:read`; unrelated scopes no longer
  imply MCP read access.

## Next Phase Readiness

- The focused security gate is green, so product contract work may begin.
- Plan 21 alone may later add the nullable
  `0287_google_health_sync_progress` migration for GH-07.
- Plan 24 must still run the final merged standard working-tree scan and dated
  dependency reconciliation before any release authorization.

## Self-Check: PASSED

- All five owned documentation, gate, and summary files exist.
- Task commits `240918358`, `56c20f26d`, `9ea0cb867`, and `fb95e3a13`
  exist in repository history.
- Documentation and gate content checks pass with no whitespace errors.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
