---
phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability
plan: "08"
subsystem: auth
tags: [passkeys, webauthn, reauthentication, postgres, credential-revocation]

requires:
  - phase: 01-03
    provides: Passkey enrollment and password-reset security contracts
provides:
  - Cookie-only passkey enrollment with fresh existing-factor proof
  - HMAC session-bound, purpose-bound, expiring, single-use registration challenges
  - Atomic operator password reset with complete credential-family revocation
affects: [passkey-management, account-recovery, session-security]

tech-stack:
  added: []
  patterns:
    - Atomic PostgreSQL DELETE RETURNING challenge claims
    - Cookie-session-bound WebAuthn registration ceremonies
    - SELECT FOR UPDATE credential-family recovery transactions

key-files:
  created: []
  modified:
    - src/lib/auth/passkey.ts
    - src/app/api/auth/passkey/register-options/route.ts
    - src/app/api/auth/passkey/register-verify/route.ts
    - src/components/settings/security-section/passkey-list-section.tsx
    - scripts/reset-password.mjs
    - tests/integration/passkey-register.test.ts

key-decisions:
  - "Bind registration challenge purpose to an HMAC of the current cookie session rather than persist or expose the raw session identifier."
  - "Claim a valid registration challenge with guarded DELETE RETURNING before WebAuthn verification and credential insertion so concurrent replay has one winner."
  - "Perform password rotation and every credential-family revocation under one locked PostgreSQL transaction."

patterns-established:
  - "Enrollment proof bootstrap: passkey and MFA-WebAuthn assertion options may be issued before registration, but registration options are created only after assertion verification."
  - "Recovery atomicity: resolve and lock exactly one user, mutate all credential families, then commit or roll back the complete operation."

requirements-completed: [SEC-05, SEC-07, SEC-08]

duration: 12min
completed: 2026-07-29
---

# Phase 01 Plan 08: Passkey Enrollment and Atomic Recovery Summary

**Fresh-factor-gated passkey enrollment with session-bound one-time challenges, plus transactional password recovery that revokes every alternate access path**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-29T11:44:43Z
- **Completed:** 2026-07-29T11:56:57Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Restricted both passkey registration legs to cookie sessions and required password, TOTP, primary-passkey, or MFA-WebAuthn proof before registration options exist.
- Bound enrollment challenges to user, purpose, cookie session, expiry, and one atomic redemption without a schema change.
- Added an accessible settings reauthentication dialog that completes the selected existing-factor proof before invoking passkey registration.
- Changed the standalone reset CLI to rotate the password and revoke sessions, API tokens, refresh tokens, trusted devices, and step-up elevations in one rollback-safe transaction.

## Task Commits

Each task was committed atomically:

1. **Task 1: Bind passkey enrollment to fresh same-session proof** - `89c83510d` (feat)
2. **Task 2: Require reauthentication in the passkey settings flow** - `7874eea04` (feat)
3. **Task 3: Make password reset atomically revoke every access path** - `9c661dcc5` (fix)

Additional blocking verification correction:

- `b7b18a6da` - Align the Plan 01-03 integration fixture with NextRequest's framework-specific init type.

## Files Created/Modified

- `src/lib/auth/passkey.ts` - Creates HMAC session-bound registration challenges and atomically claims them.
- `src/app/api/auth/passkey/register-options/route.ts` - Requires a cookie session and verifies an existing account factor before enrollment.
- `src/app/api/auth/passkey/register-verify/route.ts` - Rechecks the live session and consumes the bound challenge before credential persistence.
- `src/components/settings/security-section/passkey-list-section.tsx` - Presents password, TOTP, passkey, and security-key reauthentication before add-passkey.
- `scripts/reset-password.mjs` - Locks the target account and atomically rotates password plus all access credentials.
- `tests/integration/passkey-register.test.ts` - Uses a NextRequest-compatible test helper without changing security assertions.

## Decisions Made

- The registration challenge type carries `passkey-registration:v1:<HMAC(session)>`; raw session identifiers never enter challenge metadata.
- Foreign user/session challenges are refused without consumption, while an eligible challenge is claimed with `DELETE ... RETURNING` so replay and races lose.
- Password proof authorizes only the enrollment ceremony and does not upgrade the session's MFA freshness; strong existing factors may refresh that stamp.
- The operator reset retains plain `pg.Client` compatibility with the production standalone image and scopes every statement to the locked target user.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected the passkey integration request-helper type**

- **Found during:** Final repository typecheck
- **Issue:** The Plan 01-03 fixture annotated browser `RequestInit`, whose nullable `signal` is incompatible with Next 16's `NextRequest` constructor type.
- **Fix:** Constructed the request options inline so TypeScript infers the narrower framework-compatible shape; no assertion or runtime behavior changed.
- **Files modified:** `tests/integration/passkey-register.test.ts`
- **Verification:** `pnpm typecheck`, focused ESLint, and the full passkey integration suite pass.
- **Committed in:** `b7b18a6da`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The correction was required for the mandated repository typecheck and did not widen implementation scope or weaken the security contract.

## Issues Encountered

- The repository-wide typecheck initially exposed the fixture mismatch above; it was resolved and rerun successfully.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm typecheck` - passed.
- Focused ESLint across all TypeScript/TSX implementation and fixture files - passed.
- `node --check scripts/reset-password.mjs` - passed.
- Focused unit/static suite - 17 tests passed.
- Real-Postgres passkey, operator reset, and admin reset suites - 22 tests passed.

## Next Phase Readiness

- SEC-05, SEC-07, and SEC-08 are closed without a schema migration or first-passkey exemption.
- Passkey management and recovery flows are ready for phase-level integration verification.

## Self-Check: PASSED

- All six modified implementation/fixture files and this summary exist.
- Task commits `89c83510d`, `7874eea04`, `9c661dcc5`, and verification correction `b7b18a6da` are present in git history.

---
*Phase: 01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability*
*Completed: 2026-07-29*
