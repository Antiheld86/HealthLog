# v1.34.1 merged technical release gate

**Decision:** **BLOCK — DO NOT RELEASE**

**Gate date:** 2026-07-29

**Gate window:** 2026-07-29T13:16:37Z–2026-07-29T13:40:50Z

**Operator timezone:** Europe/Berlin
**Runtime:** Node v25.9.0, pnpm 11.15.1, Docker Server 29.4.0

This is the Plan 01-24 Task 1 technical/experience gate only. No production,
test, package, lockfile, scanner, locale, schema, or migration change was made
while diagnosing the failures below.

## Frozen candidate identity

The gate started on branch `release/v1.34.1` at
`8a3c3d096fd6aeed59587118da00fd2a0976febb`.

The initial working tree contained exactly the pre-existing unstaged changes
to `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`; staged and
untracked sets were empty.

| Identity item | Value |
|---|---|
| Initial porcelain-v2 status SHA-256 | `580eab95900630baf9f0602ce9f322ee908bdcb79e976b4557503aefd8c175ff` |
| Initial tracked-worktree manifest SHA-256 | `92c94fab5fe562c4de84567d011f03a70684ab881b1c8ee11039f0d48df07e6e` |
| Binary worktree patch SHA-256 | `b1206decc31f09b621676ac558919caf23a2190869d948fbc585fa3f38170f95` |
| `package.json` SHA-256 | `7a6dbc488beaf210808bf959b84717be462781f2aca74a5fbc157699d7b3668a` |
| `pnpm-lock.yaml` SHA-256 | `d9fa8c99e86eb4977f55395c43ca2c1781de26400870003c783e7112405970d6` |
| `pnpm-workspace.yaml` SHA-256 | `979d04c351ba838e6c8da97aa34545c9a76513710f86d84f6c07d1289d0cd054` |

During the long integration run, HEAD advanced to
`8b3b2a388e7aeea20c28b60005aa668a7dfe08ad` through the concurrent
docs-only commit `docs(01-24): record merged re-audit block`. Its only tree
deltas from the initial HEAD are `01-MERGED-REAUDIT.md` and
`01-OPS-DECISION.md`. The candidate source, tests, package worktree, and binary
patch did not change; the final binary patch and all three package hashes
remain exactly the values above.

## Locked command ledger

All durations are wall-clock seconds. “Skip” is blocking under Plan 01-24 even
when the command exits zero. Playwright retries were disabled, so the flaky
count is zero.

| Gate | Exact command | UTC start–end | Duration | Result and counts |
|---|---|---:|---:|---|
| Typecheck | `pnpm typecheck` | 13:16:37–13:16:42 | 4s | **PASS**, rc 0 |
| Lint | `pnpm lint` | 13:16:49–13:17:29 | 40s | **PASS**, rc 0; 0 errors, 6 warnings |
| Format | `pnpm format:check` | 13:17:36–13:17:59 | 23s | **FAIL**, rc 1; 10 files |
| UTC unit | `TZ=UTC pnpm test` | 13:18:10–13:19:38 | 87s | **FAIL**, rc 1; 1,630 files passed / 11 failed; 19,020 tests passed / 29 failed / 12 skipped |
| Locked build | `pnpm build` | 13:19:47–13:20:53 | 66s | **FAIL**, rc 1; compile passed, TypeScript worker aborted on default ~4 GB heap OOM |
| Real PostgreSQL integration | `pnpm test:integration` | 13:21:06–13:33:33 | 747s | rc 0 but **BLOCKED BY SKIPS**; 139 files passed; 782 passed / 3 skipped |
| Diagnostic build only | `NODE_OPTIONS=--max-old-space-size=8192 pnpm build` | 13:33:47–13:34:40 | 53s | PASS, rc 0; proves the locked-build failure is heap-ceiling dependent, but does not clear it |
| Bundle report, plan-literal invocation | `node scripts/check-bundle-budget.mjs` | 13:35:21–13:35:22 | 1s | rc 0; report only |
| Enforced bundle gate | `node scripts/check-bundle-budget.mjs --check` | 13:35:21–13:35:22 | 1s | **FAIL**, rc 1; total 3,234 KB gzip > 3,140 KB budget |
| Locale/i18n/literal guard cluster | `TZ=UTC pnpm exec vitest run src/__tests__/v1341-locale-parity.test.ts src/__tests__/i18n-reverse-coverage.test.ts src/__tests__/i18n-call-site-coverage.test.ts src/__tests__/dynamic-key-exhaustiveness.test.ts src/__tests__/insights-unit-literal-guard.test.ts src/components/measurement-reminders/__tests__/type-labels-i18n.test.ts src/components/settings/integrations/__tests__/nightscout-card.test.tsx src/components/settings/integrations/__tests__/google-health-card.test.tsx src/components/settings/import-panel/__tests__/apple-health-import-card.test.tsx src/components/insights/__tests__/insight-status-card.test.tsx` | 13:35:21–13:35:23 | 2s | **PASS**, rc 0; 9 files / 470 tests passed; 0 failed, 0 skipped |
| Privacy ledger guard | `node scripts/v1341-audit-ledger-check.mjs .planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-MERGED-REAUDIT.md` | 13:35:21 | <1s | **PASS**, rc 0; 37 unique findings, privacy scan clean |
| Full Playwright, local `.env` diagnostic | `NODE_OPTIONS='--import dotenv/config' pnpm exec playwright test --project=chromium-desktop --project=chromium-mobile` | 13:35:43–13:37:13 | 90s | **FAIL**, rc 1; 249 passed / 42 failed / 85 skipped / 36 did not run / 0 flaky |
| Full Playwright, repository CI-documented env | `CI-documented-env pnpm exec playwright test --project=chromium-desktop --project=chromium-mobile` | 13:38:59–13:40:50 | 111s | **FAIL**, rc 1; 313 passed / 3 failed / 96 skipped / 0 flaky |

The CI-documented browser environment is the environment declared in
`.github/workflows/e2e.yml`: the public dummy `ENCRYPTION_KEYS` key ring,
`ENCRYPTION_ACTIVE_KEY_ID=v1`, public dummy `API_TOKEN_HMAC_KEY`, localhost RP
settings, `SESSION_COOKIE_SECURE=false`, `NODE_ENV=production`,
`E2E_BASE_URL=http://localhost:3000`, and the local `.env` database URL. No
secret value is reproduced here.

## Blocking failures, prioritized

### P0 — Browser privacy/document serving contract fails

The configured full browser run failed the same release-critical clinician
document path in both projects:

- `e2e/share-documents.spec.ts:154` on `chromium-desktop`
- `e2e/share-documents.spec.ts:154` on `chromium-mobile`

The test expected the unlocked shared PDF request to return HTTP 200; it
returned HTTP 500 at the first Class A PDF serve assertion
(`e2e/share-documents.spec.ts:195`). The failing artifacts are under:

- `test-results/share-documents-clinician--c8ddd-e-EXIF-strip-→-revoke-→-404-chromium-desktop/`
- `test-results/share-documents-clinician--c8ddd-e-EXIF-strip-→-revoke-→-404-chromium-mobile/`

This remains a product/privacy-boundary failure after the correct test key ring
is supplied; it is not explained by the first run's local encryption-key
configuration.

### P0 — UTC unit suite is red

`TZ=UTC pnpm test` produced 29 failures in 11 files:

- `src/__tests__/written-outcome-response-consumer-guard.test.ts` — the
  consumer guard does not support the newly encountered spread form.
- `src/lib/dashboard/__tests__/meds-today.test.ts` — equal-time overdue
  boundary expectations disagree with current scheduling semantics.
- `src/app/api/admin/import-apple-health-export/__tests__/route.test.ts`
- `src/app/api/import/apple-health-export/__tests__/route.test.ts` — Apple
  Health import expectations still pin parser revision 2 while the candidate
  emits revision 3.
- `src/lib/jobs/__tests__/withings-subscription-retry.test.ts`
- `src/lib/jobs/__tests__/withings-ecg-worker.test.ts` — Withings retry/ECG
  mocks and expectations have drifted; some paths also attempted unintended
  database connections after mock fall-through.
- `src/lib/jobs/__tests__/google-health-sleep-repair.test.ts`
- `src/lib/google-health/__tests__/sync-upsert-resurrect.test.ts` — mocks are
  missing new outcome/progress exports such as
  `noteGoogleHealthOutcomeFailure` and `noteGoogleHealthMapped`.
- `src/lib/google-health/__tests__/sync-failsoft.test.ts` — assertions still
  expect the older sync DTO.
- `src/lib/jobs/reminder/__tests__/poll-cohort.test.ts` — reminder poll/cohort
  expectations are red.
- `src/lib/jobs/__tests__/apple-health-import-send-policy.test.ts` — Apple
  Health import notification/send-policy expectations are red.

The exact suite totals were 1,630 passed files / 11 failed files and 19,020
passed tests / 29 failed tests / 12 skipped tests. Both failures and skips are
release blockers.

### P0 — Formatting gate is red

Prettier rejected these exact 10 files:

1. `scripts/v1341-audit-ledger-check.mjs`
2. `scripts/v1341-performance-baseline.mjs`
3. `src/app/api/auth/passkey/register-options/route.ts`
4. `src/app/mcp/__tests__/route.test.ts`
5. `src/lib/apple-health/ecg-csv.ts`
6. `src/lib/medications/scheduling/__tests__/next-due.test.ts`
7. `tests/integration/bearer-scope-enforcement.test.ts`
8. `tests/integration/mcp-oauth-refresh-race.test.ts`
9. `tests/integration/medication-reminder-cross-midnight.test.ts`
10. `tests/integration/medication-rolling-overdue-consumers.test.ts`

### P0 — Enforced bundle budget is red

`node scripts/check-bundle-budget.mjs --check` reports total client JavaScript
of **3,234 KB gzip**, exceeding the **3,140 KB** budget by **94 KB**.

The measured route values themselves stayed below their route budgets:

- `/insights/mood/page`: 438 / 460 KB gzip
- `/page`: 431 / 460 KB gzip
- `/insights/page`: 420 / 445 KB gzip
- `/measurements/page`: 417 / 445 KB gzip

The shared baseline is 130 KB gzip, the largest chunk is 387 KB gzip, and one
Recharts-fingerprint chunk was found.

### P1 — Configured browser download contract times out

The configured run also failed:

- `e2e/settings-export.spec.ts:215` on `chromium-desktop`

`page.waitForEvent("download")` timed out after 30 seconds after clicking the
JSON import “Download example” button. Evidence:
`test-results/settings-export-Settings-→-883d1-ample-fires-a-real-download-chromium-desktop/`.
The same test is project-skipped on mobile.

### P1 — Locked build is not reproducibly green

The exact `pnpm build` compiled successfully, then the Next.js TypeScript
worker exhausted its default approximately 4 GB V8 heap and aborted with
SIGABRT. The diagnostic 8 GB invocation passed in 53 seconds. This identifies
the immediate cause but cannot substitute for the locked command required by
the release plan.

### P1 — Full real-PostgreSQL suite contains explicit skips

All executed integration coverage passed against a fresh Testcontainers
PostgreSQL database with all 281 migrations through 0287 applied: 139 files,
782 tests. The only three skips are explicit `it.skip` cases in
`tests/integration/source-priority-two-axis.test.ts`:

- line 151: per-metric override pins Withings first when Apple Health also
  reported sleep
- line 194: per-device override drops iPhone rows in favour of Apple Watch rows
- line 233: user override flips the device-type ladder so phone wins

These are deterministic coverage gaps, not flakes, and are blocking under the
plan.

### P2 — Browser project skips remain blocking

The correctly configured browser matrix reported 96 skipped tests. These are
mostly deliberate project/viewport selection guards, including the canonical
five-image capture being desktop-only and the desktop sidebar skip-link check
being skipped on mobile. Plan 01-24 nevertheless says any skip is blocking.

The first browser invocation is retained as diagnostic evidence. Its 40
document/share failures were all `RangeError: Invalid key length` from
`e2e/setup/vault-fixture.ts:65`, matching the server's missing/invalid
encryption-key boot warning; one download timeout and one cross-project
“Today” state assertion accounted for the other two failures. Supplying the
repository's documented test key ring removed that environmental failure
class, leaving the three configured-run failures above.

## Real-boundary coverage

The full `pnpm test:integration` invocation includes the required MCP refresh
race, reset-password rollback/revocation, medication reminder midnight,
rolling-overdue consumers, Apple Health ECG import, Google Health workout
terminal/progress, and the remainder of the real-PostgreSQL integration suite.
No focused suite was substituted for the full run.

## Axe/accessibility result

The configured browser run's main `e2e/a11y.spec.ts` matrix completed with no
reported blocking axe violations:

- Desktop: 11 passed, 0 failed, 0 skipped.
- Mobile/phone: 10 passed, 0 failed, 1 project-design skip (desktop sidebar
  logo/skip-link interaction).
- Both light and dark themes passed the public login surface, Insights/workout/
  Coach matrix, measurement/mood/medication/lab/document matrix, retained
  settings/admin matrix, and open OCR/Coach/medication/document states.
- The document-vault axe cases also passed all three desktop states. On mobile,
  the vault timeline axe case passed while the open-sheet and bulk-state cases
  were project-skipped.

Thus no serious/critical WCAG blocker was emitted by executed axe scans, but
the accessibility gate cannot be declared green because Plan 01-24 treats its
skips as blocking.

## Deterministic visual artifacts

The configured rerun regenerated the following final files:

| Artifact | Viewport | Final SHA-256 |
|---|---:|---|
| `test-results/v1341/dashboard-desktop.png` | 1440×900 | `f73649b68b048711be9ea2abd73b95a15b63d5b76d2390bef80648ffa93ad89f` |
| `test-results/v1341/insights-mobile.png` | 390×844 | `0c85df2fbcb721d4b96015e44306908e32c13f741a523cfdad97950b55fc0c3e` |
| `test-results/v1341/anamnesis-desktop.png` | 1440×900 | `dc02dfa25e579b59c1476f61f6f286a5b3f4e0d71fad862a7972addf16ccf694` |
| `test-results/v1341/settings-short-desktop.png` | 1280×600 | `10d83524d87bf7b4d5c962c3c304bd6e3b585b2363cd7f76f158b9defa2ed43a` |
| `test-results/v1341/admin-tablet.png` | 900×800 | `6776d340f777cb9003373d7a23436b18845eb980cda699df19b9168af1637aa3` |

Manual review of the final pixels found no visible horizontal overflow,
unintended overlap, broken glyph, raw i18n key, or clipped primary control:

- Dashboard desktop: sidebar, hero, four metric cards, ranges, and chart frame
  align; the chart continues below the viewport as expected.
- Insights phone: the pill strip remains within the viewport, long pill text is
  intentionally truncated, the score card is readable, and fixed bottom/Coach
  controls remain usable.
- Anamnesis desktop: both navigation columns align, all access toggles remain
  inside the card, and the lower form scrolls naturally below the viewport.
- Settings short desktop: the global and settings navigation stay pinned and
  the account cards remain contained at 600 px height.
- Admin tablet: condensed global rail, admin navigation, host chart, and status
  cards remain contained and aligned at 900 px.

There is a determinism caveat: two successive captures on the same candidate
produced different hashes for Dashboard
(`173622c4…` then `f73649b6…`) and Admin
(`2c93cb58…` then `6776d340…`) because their pixels include live “Just in” /
started times and live host metrics. The other three hashes were identical
between runs. The required named artifacts exist and were reviewed, but the
Dashboard/Admin files are not byte-deterministic.

## Non-blocking observations

Lint completed with six warnings and no errors:

- `_request` in `src/app/api/google-health/sync/status/route.ts`
- four warnings in `safe-fetch-pinned.test.ts`
- `_args` in `sync-progress.test.ts`

The high-memory build also emitted the existing Next.js
`middlewareClientMaxBodySize` deprecation and repeated missing `metadataBase`
warnings.

## Exit decision

The merged technical candidate is **not releasable**. At minimum, the clinician
shared-document HTTP 500, UTC unit failures/skips, 10 formatting failures,
94 KB bundle-budget overage, locked-build OOM, integration skips, configured
browser download failure, and browser project skips must be resolved and the
entire frozen-snapshot gate rerun with zero failures, zero skips, and zero
flakes before any version, PR, tag, image, or deployment action.
