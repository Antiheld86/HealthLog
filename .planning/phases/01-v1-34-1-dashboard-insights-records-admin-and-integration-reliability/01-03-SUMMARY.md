---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "03"
subsystem: auth-testing
tags: [vitest, testcontainers, postgres, webauthn, credential-revocation]

requires:
  - phase: 01-security-research
    provides: Cookie-only enrollment and atomic recovery threat model
provides:
  - RED final-boundary contracts for fresh existing-factor passkey enrollment
  - RED user/purpose/session/expiry/single-use challenge-binding matrix
  - RED real-PostgreSQL password-reset revocation and rollback contract
  - Green Admin API reset parity coverage for the complete credential family
affects: [01-08, 01-09, passkey-enrollment, password-recovery]

tech-stack:
  added: []
  patterns:
    - Real PostgreSQL persistence assertions around mocked WebAuthn cryptography
    - Test-only PostgreSQL trigger injection for transaction rollback proof

key-files:
  created:
    - src/components/settings/security-section/__tests__/passkey-enrollment-reauth.test.tsx
    - tests/integration/reset-password-revocation.test.ts
  modified:
    - tests/integration/passkey-register.test.ts
    - src/app/api/auth/passkeys/__tests__/route.test.ts
    - tests/integration/admin-reset-password.test.ts

key-decisions:
  - "The cookie reauthentication proof is presented before register-options; an ambient cookie or Bearer elevation is never enrollment authority."
  - "Rollback is forced with a test-only PostgreSQL DELETE trigger so atomicity is proven without a schema migration or production test hook."

patterns-established:
  - "Enrollment RED matrix: positive existing factors and attacker-negative binding cases reach the final route and database boundaries."
  - "Recovery RED matrix: execute the production CLI as a child process and inspect every credential-family table."

requirements-completed: [SEC-05, SEC-07, SEC-08]

duration: 11min
completed: 2026-07-29
---

# Phase 01 Plan 03: Credential Enrollment and Recovery RED Contracts Summary

**Cookie-only passkey challenge-binding and atomic PostgreSQL reset/revocation behavior are specified as durable RED contracts before production remediation.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-29T11:31:33Z
- **Completed:** 2026-07-29T11:42:31Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added real-PostgreSQL passkey enrollment coverage for password, primary passkey, TOTP, and MFA WebAuthn proof, plus ambient cookie, Bearer, stale, foreign-user/session, wrong-purpose, expired, and replay attacks.
- Pinned the Settings flow to finish reauthentication before requesting registration options, preserving one cookie-bound options → WebAuthn → verify ceremony.
- Added a production-CLI subprocess suite proving complete credential-family revocation, unrelated-admin isolation, safe input failures, and rollback through an injected database failure.
- Extended Admin API parity coverage to trusted devices and step-up elevations while confirming the administrator's own session and API token survive.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add two-leg cookie-only, existing-factor passkey regressions** - `9f6cd86c0` (test)
2. **Task 2: Pin the passkey enrollment reauthentication UX** - `3f4afb26a` (test)
3. **Task 3: Add atomic password-reset revocation and rollback coverage** - `abea48026` (test)

## Files Created/Modified

- `tests/integration/passkey-register.test.ts` - Final route/database enrollment proof and challenge-binding matrix.
- `src/app/api/auth/passkeys/__tests__/route.test.ts` - Static route guard contracts requiring cookie-only handling on both registration legs.
- `src/components/settings/security-section/__tests__/passkey-enrollment-reauth.test.tsx` - Factor availability and proof-before-challenge UI ordering contract.
- `tests/integration/reset-password-revocation.test.ts` - Real CLI/PostgreSQL reset, revocation, isolation, validation, and rollback coverage.
- `tests/integration/admin-reset-password.test.ts` - Complete credential-family parity assertions for the existing Admin API path.

## Verification

The Wave 0 plan intentionally requires failing contracts against current production code.

- Passkey PostgreSQL suite: **12 failed, 2 passed**. Expected RED causes are generic `registration` challenge purpose, ambient/wildcard authorization, and missing stale/session/user/purpose/expiry/replay checks.
- Passkey route unit suite: **2 failed, 3 passed**. Expected RED cause is both registration routes still using generic `requireAuth` without same-session proof handling.
- Passkey UI suite: **2 failed, 1 passed**. Expected RED cause is the missing factor chooser and missing proof-before-options step; the existing options → registration → verify ordering passes.
- Reset/Admin PostgreSQL suites: **2 failed, 6 passed**. The Admin parity suite is green; CLI RED causes are surviving target credentials and no transaction path reaching the injected rollback failure.
- Focused ESLint, Prettier, and `git diff --check` passed for all owned test files.

## Decisions Made

- Used the existing step-up proof vocabulary (`password`, `passkey`, `totp`, `webauthn`) for the enrollment contract, but explicitly prohibited the Bearer elevation transport.
- Mocked only WebAuthn cryptography; route policy, AuthChallenge persistence, Passkey persistence, CLI execution, and credential revocation use actual application/database boundaries.
- Forced rollback through PostgreSQL itself so the future CLI must encounter a real statement failure after opening its transaction.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- In this shell, forwarding paths through `pnpm test:integration -- ...` caused Vitest to select the full integration suite. Focused verification used the equivalent direct command, `pnpm exec vitest run --config vitest.integration.config.mts <files>`, while retaining the plan's expected non-zero RED assertion.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 01-08 can implement the cookie proof, bound challenge redemption, UI reauthentication, and transactional CLI directly against these RED contracts.
- The package, lock, workspace, schema, migrations, and production implementation files remain untouched.

## Self-Check: PASSED

- All five owned test files and this summary exist.
- Task commits `9f6cd86c0`, `3f4afb26a`, and `abea48026` are present.
- Summary formatting and diff whitespace checks pass.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
