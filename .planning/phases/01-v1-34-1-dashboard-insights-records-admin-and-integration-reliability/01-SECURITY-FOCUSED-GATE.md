# Phase 01 focused security gate

**Date:** 2026-07-29  
**Started:** 2026-07-29T12:01:29Z  
**Source commit:** `ddbfcb4588f22f29f807a42c437847de9e811b24`  
**Branch:** `release/v1.34.1`  
**Verdict:** **BLOCKED by the plan's test-script forwarding syntax; focused security boundaries are green**

## Results

| Boundary | Command | Files | Passed | Failed | Skipped | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Literal Plan 01-09 unit command | `TZ=UTC pnpm test -- <20 security files>` | 1,629 | 18,905 | 1 | 12 | Blocked |
| Focused unit/component correction | `TZ=UTC pnpm exec vitest run <20 security files>` | 20 | 305 | 0 | 0 | Pass |
| Literal Plan 01-09 integration command | `pnpm test:integration -- <5 security files>` | not focused | not used | not used | not used | Stopped after confirming unintended full-catalog execution |
| Focused real-PostgreSQL correction | `pnpm exec vitest run --config vitest.integration.config.mts <5 security files>` | 5 | 46 | 0 | 0 | Pass |
| Types | `pnpm typecheck` | — | — | 0 | 0 | Pass |
| Production lint | `pnpm exec eslint <18 exact security production paths>` | 18 | — | 0 | 0 | Pass |

The literal commands insert a standalone `--` after Vitest's `run` command.
With Vitest 4.1.5 that does not forward the following paths as a file
allowlist. Both package scripts therefore select their entire configured test
catalog instead of the named files.

The resulting repository-wide unit run completed with 1,629 files and 18,918
tests. Its only failure was the out-of-scope
`src/__tests__/i18n-reverse-coverage.test.ts`, which found the two unused
locale keys `settings.nightscoutPrivateHost` and
`settings.nightscoutPrivateHostHelp`; it also contained 12 unrelated skips.
Because Plan 01-09 declares any failure or skip a blocker, the literal chained
command stopped before PostgreSQL, typecheck, and lint. No locale file or
out-of-scope source was edited. The direct commands above are the
authoritative focused security evidence.

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

## Blocker

The focused implementation does not require a security-source fix. The
remaining blocker is outside Plans 01-05 through 01-08:

1. correct the plan/package invocation so Vitest receives the file allowlist
   without the extra `--`; and
2. resolve or intentionally schedule the unrelated reverse-i18n orphan keys
   before claiming the literal repository-wide run is green.

This report does not authorize release. The final merged-tree release gate
must supersede it.
