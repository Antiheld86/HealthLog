# Phase 01 focused security gate

**Date:** 2026-07-29
**Started:** 2026-07-29T12:01:29Z
**Source commit:** `ddbfcb4588f22f29f807a42c437847de9e811b24`
**Branch:** `release/v1.34.1`
**Verdict:** **GREEN — all focused security boundaries pass with zero skipped tests**

## Results

| Boundary | Command | Files | Passed | Failed | Skipped | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Focused unit/component gate | `TZ=UTC pnpm exec vitest run <20 security files>` | 20 | 305 | 0 | 0 | Pass |
| Focused real-PostgreSQL gate | `pnpm exec vitest run --config vitest.integration.config.mts <5 security files>` | 5 | 46 | 0 | 0 | Pass |
| Types | `pnpm typecheck` | — | — | 0 | 0 | Pass |
| Focused lint | `pnpm exec eslint <19 exact security paths>` | 19 | — | 0 errors | 0 skipped | Pass (4 pre-existing test-fixture warnings) |

The first draft of Plan 01-09 inserted a standalone `--` after Vitest's `run`
command. With Vitest 4.1.5 that did not forward the following paths as a file
allowlist; both package scripts selected their entire configured test catalog
instead of the named files. The planner corrected the commands to the direct
forms shown above, which are the exact revised Plan 01-09 gate commands.

For auditability, the unintended repository-wide unit run completed with 1,629
files and 18,918 tests: 18,905 passed, 1 failed, and 12 unrelated tests were
skipped. Its only failure was the out-of-scope
`src/__tests__/i18n-reverse-coverage.test.ts`, which found the two unused
locale keys `settings.nightscoutPrivateHost` and
`settings.nightscoutPrivateHostHelp`. The obsolete chained command stopped
before PostgreSQL, typecheck, and lint. No locale file or out-of-scope source
was edited. The corrected focused commands above contain no test skip or
failure and are the authoritative security evidence.

The exact revised ESLint allowlist exits zero. Its only diagnostics are four
pre-existing `@typescript-eslint/no-unused-vars` warnings in
`src/lib/__tests__/safe-fetch-pinned.test.ts`; there are no lint errors.

## Requirement evidence

| Requirement | Legitimate-positive boundary | Attacker-negative boundary | Evidence |
| --- | --- | --- | --- |
| SEC-01 | `health:read` and `*` tokens register and invoke MCP read tools. | Empty, write-only, FHIR, ingest, unrelated, revoked, expired, and unknown tokens fail before tool registration or health-data access. | MCP auth/scopes/route and real bearer-scope suites |
| SEC-02 | Public immutable assets and the data-free offline shell remain available; allowed query snapshots restore. | Authenticated root HTML is never precached, stale navigation shells are refused, logout removes current and legacy HealthLog caches, and sensitive query families are never persisted. | Service-worker, SW-hardening, and query-persister suites |
| SEC-03 | Genuinely public IPv4 and IPv6 literals and DNS results pass through the pinned dispatcher. | Private IPv4 embedded in mapped, compatible, NAT64, and 6to4 IPv6 forms is rejected for literal and resolved destinations; redirect and rebinding paths remain pinned. | Notifications, dispatcher, and pinned-fetch suites |
| SEC-04 | Sequential MCP refresh rotation produces one usable successor. | Concurrent replay transactionally revokes the connection family and linked access tokens; the losing branch and every successor are unusable. | OAuth token/connections unit suites and real PostgreSQL refresh-race suite |
| SEC-05 | Fresh password, TOTP, primary-passkey, and MFA-WebAuthn proofs can enroll a passkey from the same cookie session. | Bearer, missing/stale proof, foreign session/user, wrong-purpose, expired, and replayed challenges cannot create a credential. | Passkey route/library/component suites and real PostgreSQL registration suite |
| SEC-06 | Public Nightscout origins and an exact operator-approved private `scheme://host:port` origin connect and sync. | The legacy user opt-in, mismatched scheme/port/host, related hostname, unapproved private DNS, and unsafe redirects do not grant egress. | Nightscout validation/client/sync/route/card suites |
| SEC-07 | A valid operator reset changes the target password and revokes sessions, API tokens, refresh tokens, trusted devices, and elevations while preserving unrelated users. | Weak, unauthorized, missing-user, and injected-failure paths do not leave partial password or credential-family state. | Real PostgreSQL operator-reset and admin-reset suites |
| SEC-08 | All named final enforcement boundaries retain their public or authorized positive behavior. | The focused 20-file and 5-file runs contain zero failures, zero skips, and no surviving replay/session/race branch. | 305 unit/component plus 46 PostgreSQL tests |

## Corrected command deviation

No security-source fix was required. The planner corrected the test invocation
after the first draft's wrapper syntax selected the full catalogs. The
unrelated reverse-i18n orphan keys remain outside Plans 01-05 through 01-08
and were not edited here; Plan 23 owns locale reconciliation.

This focused gate is green but does not authorize release. The final
merged-tree release gate must supersede it.

## Security scope freeze

The immutable execution baseline was recomputed immediately before this
attestation and matched exactly:

| Baseline item | Required and observed value |
| --- | --- |
| Branch | `release/v1.34.1` |
| Binary package/workspace diff SHA-256 | `b1206decc31f09b621676ac558919caf23a2190869d948fbc585fa3f38170f95` |
| `package.json` SHA-256 | `7a6dbc488beaf210808bf959b84717be462781f2aca74a5fbc157699d7b3668a` |
| `pnpm-lock.yaml` SHA-256 | `d9fa8c99e86eb4977f55395c43ca2c1781de26400870003c783e7112405970d6` |
| `pnpm-workspace.yaml` SHA-256 | `979d04c351ba838e6c8da97aa34545c9a76513710f86d84f6c07d1289d0cd054` |

The package/workspace changes remain the user-owned
`@openai/codex-security` installation baseline. Plan 01-09 did not reinstall,
upgrade, normalize, stage, or otherwise change those files.

The security-remediation scope is frozen as follows:

- no migration is added for the security work at this gate;
- no package, lockfile, or workspace change is made;
- no dependency upgrade is performed;
- no Deep scan is run; and
- the five accepted Low scanner findings receive no code change in v1.34.1.

Plan 21 may later add only the safe additive
`0287_google_health_sync_progress` migration for GH-07: one nullable JSONB
`sync_progress` column on `google_health_connections`, with bounded
current-run-only status. That planned correctness migration is not a security
remediation and does not relax this freeze.

Plan 24 still requires the final merged standard working-tree security scan
and dated dependency reconciliation. Until that later gate is green, the
current scanner and dependency evidence is provisional.

## Superseding execution sequence

1. Complete this focused security gate first.
2. Wave 3 establishes RED contracts in Plans 10–13.
3. Wave 4 establishes the cohort contract and baseline, then implements the
   disjoint UI/navigation work in Plans 14–17.
4. Wave 5 implements correctness, Apple Health, AI, and Google Health work in
   Plans 18–21.
5. Wave 6 implements cohort behavior in Plan 22.
6. Wave 7 reconciles locale copy in Plan 23.
7. Only Plan 24's merged-tree re-audit supersedes the pre-implementation
   correctness, live, and performance reports and can authorize release.
