# Contributor notes

Working notes for anyone (human or otherwise) editing this repository. Skim before the first PR; refer back when a convention question comes up. Pair with `README.md` (the public face) and `CHANGELOG.md` (the release history); this file is the maintainer's operating manual.

## What HealthLog is

Self-hosted personal-health-tracking PWA: weight, blood pressure, pulse, body composition, glucose, sleep, mood, medication compliance. Withings + Apple Health sync, multi-provider AI Insights (BYOK or local), doctor-report PDF, native iOS client in public beta. Single `docker compose up`, Postgres-backed, AES-256-GCM at rest. PolyForm Noncommercial 1.0.0 (AGPL-3.0 through v1.15.18). Current line: v1.20.x.

## Voice and privacy

Hard rules for every committed artefact — commit messages, CHANGELOG entries, PR bodies, code comments, GitHub release notes, docs site copy. Treat these as the project's public face.

- **Voice.** English. Maintainer prose: present-tense, imperative for commits, factual for prose. No marketing tone, no apology tone, no "wow what a cool feature" framing. The voice is one human writing notes for the next.
- **No assistant / tooling references.** Do not surface AI, agent, assistant, copilot, marathon, phase, wave, round, or session vocabulary into anything that lands on GitHub — including commit messages and trailers. Commits carry no `Co-Authored-By` tooling trailer; they are authored by the maintainer's git identity alone.
- **No personal data.** No real names (the maintainer's, a reporter's, or anyone else's). No live health figures, no live tenant identifiers, no real-account anchors. Generalise to "a self-hoster", "a user", "an operator", "an authenticated session", etc. The internal `.planning/*` files are gitignored and exempt; everywhere else in the repo, no.

If a draft commit message or release note would violate one of the three, rewrite it before committing. The `git log` is more durable than today's task.

## Branch and release model

`main` is the single trunk and is always releasable. There is no long-lived `develop` branch — the former one was retired and archived as the tag `archive/develop-pre-v1.5` (it carried no work absent from `main`; a long-lived integration branch has no role in a single-maintainer shop and only accrued back-merge debt). This is trunk-based development with release tags: short-lived branches off `main`, work always converges back onto `main`, and the immutable `vX.Y.Z` image built from a tag on `main` is the one source of truth — including for the OpenAPI contract the iOS client consumes.

- **Trunk.** `main` always builds, passes CI, and is deployable. Every commit on it is a release commit (`chore(release): vX.Y.Z`), a release-branch merge, or a maintenance commit (docs, gitignore, audit findings) applied directly.
- **A release** is built on a short-lived `release/vX.Y.Z` branch cut off `main` — built wave-by-wave, then opened as a PR `release/vX.Y.Z` → `main` with green CI, merged (merge-commit), and tagged `vX.Y.Z`. The tag push triggers `docker-publish.yml` (GHCR multi-arch + `:latest`). Deploy is manual (see `docs/ops/deploy.md`); after a deploy, verify `/api/version` (it returns `version` + `buildSha` + `builtAt`) on every target, since the `:latest` pull is the source of truth, not the queued deploy status. Delete the release branch after merge.
- **Small standalone changes** (a single fix, a docs touch) can go through a short-lived `fix/X` / `feat/X` branch + PR, or directly onto `main` when the maintainer chooses — `main` is the target either way.
- **Hotfixes** branch from `main` and merge straight back to `main`. There is no second long-lived line to forward-port to, so the old back-merge debt cannot recur by construction.
- Never force-push `main` or any release branch. Never skip hooks (`--no-verify`). Never `--no-gpg-sign` unless explicitly asked.

## Semver

Prefer patch bumps. A release dominated by bug fixes plus additive features without breaking changes ships as `vX.Y.Z+1`, not `vX.Y+1.0`. Bumping minor is reserved for breaking changes, removed flags, deprecated routes, or multi-feature milestones framed as such (e.g. v1.5 = native iOS client + Apple Health integration). Pre-existing example: a `v1.5.0` cut was rerouted to `v1.4.14` mid-flight when the diff turned out to be bugfix-dominated.

## Tech stack at a glance

| Layer              | Tech                                                                                   | Notes                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node 22 (Alpine) + pnpm 10.31                                                          | Node version fixed only by the Dockerfile base image; no `.nvmrc` or `engines`.                                                                                     |
| Framework          | Next.js 16.2.6 — App Router, `output: "standalone"`                                    | SWC strips `console.*` in prod except `error/warn`.                                                                                                                 |
| Language           | TypeScript 6, `strict: true`, `moduleResolution: "bundler"`                            | Path alias `@/*` → `./src/*`. `scripts/` excluded from typecheck.                                                                                                   |
| UI                 | React 19 (exact pin), Tailwind 4, shadcn/ui (new-york style, zinc base), Radix, Lucide | Recharts 3 for charts — stays; replacement requires explicit approval.                                                                                              |
| Persistence        | PostgreSQL 16 + Prisma 7.8 — 115 models                                                 | Generated client at `src/generated/prisma`. Production image ships a separate `/opt/prisma-cli` install + `/opt/pg-boss` runtime install (see `Dockerfile:93-100`). |
| Queue              | pg-boss 12.18                                                                          | Cron + retry semantics live in Postgres tables; workers under `src/lib/jobs/`.                                                                                      |
| Auth               | `@simplewebauthn/server` 13, `@node-rs/argon2` 2                                       | Passkey + Argon2id password, server-side sessions in Postgres.                                                                                                      |
| Notifications      | `@parse/node-apn` 8 (APNs), `web-push` 3 (VAPID), raw fetch for Telegram + ntfy        | Per-channel `recordPushAttempt` row, hard-reject classification.                                                                                                    |
| Forms / validation | `react-hook-form` 7 + `zod` 4 + `@hookform/resolvers` + `zod-openapi` 5                | The Zod registry is the source of truth for `docs/api/openapi.yaml`.                                                                                                |
| Testing            | Vitest 4 (unit + integration), Playwright 1.60 (e2e), `@axe-core/playwright`           | Integration runs against a `testcontainers/postgresql` Postgres 16.                                                                                                 |
| Container          | Multi-stage Alpine Dockerfile, GHCR multi-arch (`amd64` + `arm64`)                     | `pull_policy: always` in `docker-compose.yml` is load-bearing — without it Docker re-uses the stale `:latest` digest.                                               |

More detail in `.planning/codebase/tech.md`, generated as part of the v1.5.2 codebase audit.

## How a request flows

```
client
  │ HTTP
  ▼
src/proxy.ts                         renamed from middleware.ts. Public-path allowlist,
  │                                  demo-mode mutation block, server-side onboarding
  │                                  redirect, worker-only refusal, request-id + nonce
  │                                  generation, every security header.
  ▼
src/app/<route>/route.ts             every API route wraps in `apiHandler(...)`
  │
  ▼
src/lib/api-handler.ts               WideEventBuilder + AsyncLocalStorage, auth resolver
  │                                  (cookie OR Bearer), idempotency, error envelope,
  │                                  GlitchTip forwarder. Cookie path can elevate to
  │                                  admin via requireAdmin(); Bearer never can.
  ▼
handler body                         Zod parse (`safeParse` + `returnAllZodIssues`),
  │                                  business logic, `annotate({ action, meta })`,
  │                                  `auditLog()` for sensitive ops.
  ▼
src/lib/api-response.ts              `apiSuccess(data, status?)` → `{ data, error: null }`;
  │                                  `apiError(msg, status, meta?)` threads `meta` on the
  │                                  error path only — `{ data: null, error, meta? }`.
  ▼
src/proxy.ts                         security headers attach, request-id echoes.
  ▼
client
```

The architecture map in `.planning/codebase/arch.md` walks each layer with file:line citations.

## Code conventions

- **UI work follows the design standards.** `.planning/audits/2026-07-05-fable/UI-STANDARDS.md` is the binding design rulebook (card anatomy via TileHeader, spacing scale, text-colour rules — foreground for content, muted for meta only —, token discipline, primitive mapping). Read it before touching any surface; deviations need a written reason in the PR. Where the standards conflict with older in-file comments, the standards win.
- **RSC by default.** Server components are the default; add `"use client"` only when a hook, state, or browser API actually needs it.
- **Every API route wraps in `apiHandler`, with three documented exceptions.** The MCP OAuth routes (`mcp/oauth/{authorize,token,register}`) use `withBackgroundEvent` instead, because OAuth requires RFC-format error bodies that the standard envelope cannot express. They carry the same protections by hand — rate limit, body cap, kill switch, mandatory PKCE-S256, redirect-URI allowlist. Every other route wraps. Every body-accepting route runs Zod `safeParse` and returns 422 via `returnAllZodIssues` (multi-issue envelope sanitised against echoed input through `sanitiseZodIssues`).
- **`userId` is always narrowed from session or Bearer.** No route accepts `userId` as a body field — it comes from `requireAuth()` and feeds the Prisma `where`. The batch endpoints (`/api/measurements/batch`, `/api/mood-entries/bulk`, `/api/medications/intake/bulk`, `/api/workouts/batch`) don't even declare a `userId` field in their Zod schemas.
- **No mass assignment.** Every `prisma.X.{create,update}({ data: ... })` builds its `data` object field-by-field from `parsed.data`, never by spreading the parsed object whole. `tokens.create` builds `permissions` from a hardcoded literal, never from request input.
- **A two-ended change carries both ends.** Adding a column, a payload field, or a user preference without its consumer is the failure mode this repo keeps rediscovering: the column ships with the schema change, the reader is "the follow-up", and nothing in the gate notices because every other check proves one end. So the consumer lands in the same release branch, or the schema comment says why it cannot: `/// @internal: <reason>` for something deliberately never surfaced, `/// @pending-consumer(#issue)` for a consumer that is genuinely still coming. `pnpm dlx tsx scripts/audit-column-readers.ts` sweeps for unannotated write-only columns and re-lists every `@pending-consumer` marker so a follow-up that never happened surfaces at the next release audit. Run it in the deep-audit step; it is a review tool with a grep-shaped matcher, deliberately not a gate. The two questions that can be answered exactly are gates instead — `account-payload-consumer-guard.test.ts` (every `/api/auth/me` field has a client reader) and `measurement-backup-completeness.test.ts` (every `Measurement` column reaches the backup).
- **Bearer scope is fail-closed.** `requireAuth()` with no argument admits a cookie session or a wildcard (`["*"]`) token only — a narrow-scope token is refused with 403 and an `undeclared_scope` audit row. A route that means to accept a narrow token names the scope: `requireAuth(FHIR_READ_SCOPE)`. Adding a route therefore cannot silently widen an existing token's reach, because the default arm denies. Only the login / passkey / refresh paths mint `["*"]`; every user-facing mint is narrow, and narrow now means narrow. Two surfaces resolve a Bearer token outside `requireAuth` — `/api/ingest/medication` and `/mcp` — and that set is frozen by a structural test (`src/__tests__/bearer-scope-enforcement-guard.test.ts`).
- **`requireAdmin()` is cookie-only.** Bearer tokens — even with `["*"]` scope — cannot reach admin endpoints. This is a structural boundary in `requireAdmin()` (`src/lib/api-handler.ts`), not a runtime check that future code can soften.
- **Raw SQL is parameter-bound or whitelist-spliced.** Every `$queryRaw` uses tagged-template parameters. Every `$queryRawUnsafe` / `$executeRawUnsafe` either passes positional `$N` placeholders with an argument array OR splices a value already asserted against a closed enum + regex (see the whitelist-splice block in `src/lib/rollups/measurement-rollups.ts`, around the `$queryRawUnsafe` calls). Inline comments document the whitelist at the splice point.
- **TanStack Query keys live in the centralised factory.** `src/lib/query-keys/` (16 modules, `index.ts` barrel) is the only legal source of `queryKey` / `mutationKey` arrays. The in-repo ESLint rule `healthlog/queryKey-factory` (set to `error`) flags any bare array. Same-key + different `queryFn` shape silently poisons the cache; the factory prevents it. Every read unwraps `(await res.json()).data` from the envelope.
- **`annotate()` on every interesting code path.** Wide-event observability. Action names follow `<surface>.<noun>.<verb>` (`coach.budget.exceeded`, `measurement.batch.ingest`). Don't free-text in `meta` — pin the shape so dashboards stay stable.
- **i18n keys exist for every `t()` call.** `i18n-call-site-coverage.test.ts` walks every `.ts(x)` under `src/`, extracts every `t("ns.key")` literal, and asserts each key resolves in `messages/en.json`. `i18n-locale-integrity.test.ts` propagates the EN guarantee across `de / en / es / fr / it / pl`. If a guard fails, fix the bundle, don't suppress the test.
- **OpenAPI registry stays in sync.** Zod schemas carry `.meta()` annotations under `src/lib/openapi/`; `pnpm openapi:generate` emits `docs/api/openapi.yaml`. CI fails on drift. Re-run the generator after touching a request / response schema and commit the YAML alongside the Zod change.
- **File naming.** Components and lib files: kebab-case (`daily-briefing.tsx`, `secure-cookie.ts`). Hooks: `use-` prefix kebab-case (`use-coach-prefs.ts`). React component exports stay PascalCase regardless of filename.

## Tests and commands

- `pnpm typecheck` — `tsc --noEmit`. Required before every commit.
- `pnpm lint` — ESLint flat config with `eslint-config-next` + the project's `healthlog/queryKey-factory` rule. One harmless warning in `withings/resume/__tests__/route.test.ts` is allowed; everything else should be clean.
- `pnpm test` — Vitest 4 unit + component suite. Required before pushing a fix; full suite is fast (~30 s).
- `pnpm test:integration` — Vitest against a `testcontainers/postgresql` Postgres 16. Needs Docker / OrbStack running. Slower but pins the contracts the unit-mocks can't.
- `pnpm e2e` — Playwright against `pnpm exec next build` + Postgres. Heavy; CI runs it, locally only when touching UI flows.
- `pnpm openapi:generate` — regenerates `docs/api/openapi.yaml` from the Zod registry. Run after any request / response schema change. CI's `openapi:check` fails the build on drift.
- `pnpm check-env` — validates that `.env.production.example` covers every required variable. Wired into CI as `env-check.yml`.
- `pnpm bundle-report` / `ANALYZE=1 pnpm build` — bundle inspection. Use when a feature adds material weight.
- One-shot scripts live in `scripts/`. Run them via `pnpm dlx tsx scripts/<file>.ts` — the production standalone image strips `tsx` and the bare `pnpm tsx ...` invocation fails inside the container. Recurring tasks belong on pg-boss, not on a CLI script.

## Critical-files map

| Concern                 | File                                                                                                                                                                | What it owns                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP edge               | `src/proxy.ts`                                                                                                                                                      | Public-path allowlist, demo-mode block, onboarding redirect, request-id + CSP nonce, every security header, worker-only refusal.                                                         |
| API kit                 | `src/lib/api-handler.ts`                                                                                                                                            | `apiHandler` wrapper, `requireAuth` / `requireAdmin`, idempotency plumbing, GlitchTip forwarder.                                                                                         |
| Response envelope       | `src/lib/api-response.ts`                                                                                                                                           | `apiSuccess` / `apiError`, `safeJson` (now with opt-in `maxBytes`), trusted-proxy IP resolver, `returnAllZodIssues` + `sanitiseZodIssues`.                                               |
| Crypto at rest          | `src/lib/crypto.ts`                                                                                                                                                 | AES-256-GCM with versioned key ids, `extractKeyId`, fail-closed loader, rotation primitives. Rotation CLI: `scripts/rotate-encryption-key.ts`.                                           |
| Session                 | `src/lib/auth/session.ts` + `src/lib/auth/secure-cookie.ts`                                                                                                         | Postgres-backed sessions, sliding 30-day expiry, `shouldEmitSecureCookie()` the one source of truth for the `Secure` flag (every cookie setter routes through it).                       |
| Refresh tokens          | `src/lib/auth/refresh-token.ts`                                                                                                                                     | Per-device one-time-use rotation with reuse-detection that revokes the device's token family.                                                                                            |
| Bearer tokens           | `src/lib/auth/hmac.ts` + `src/lib/auth/issue-token.ts`                                                                                                              | HMAC-SHA256 hashing under `API_TOKEN_HMAC_KEY`; no plaintext path; `lastUsedAt` updated fire-and-forget.                                                                                 |
| Rollup tier             | `src/lib/rollups/`                                                                                                                                                  | DAY / WEEK / MONTH / YEAR pre-aggregations. Read-swap pattern: try the rollup, fall back to live SQL only on coverage miss. Boot-time `rollup-full-backfill` queue handles new accounts. |
| Compliance              | `src/lib/analytics/compliance.ts`                                                                                                                                   | Cadence-aware medication compliance — daysOfWeek + intervalWeeks honoured across the eight call sites that surface a rate (Coach prompt, BP-status gate, dashboard pillar, …).           |
| AI providers            | `src/lib/ai/provider.ts` (`resolveProvider`) + `src/lib/ai/provider-chain.ts` (`PROVIDER_CHAIN_TYPES`) + `src/lib/ai/{openai,anthropic,local,codex,mock}-client.ts` | Five providers, hand-rolled fetch over the documented wire (no vendor SDKs). Mock is excluded structurally by the `PROVIDER_CHAIN_TYPES` allowlist — production cannot reach it.         |
| Notification dispatcher | `src/lib/notifications/dispatcher.ts` + `src/lib/notifications/senders/`                                                                                            | APNs → Telegram → ntfy → Web Push cascade, hard-reject classification, `push_attempts` ledger with 90-day retention.                                                                     |
| Coach                   | `src/app/api/insights/chat/route.ts` + `src/lib/ai/coach/`                                                                                                          | SSE stream, budget gate + per-user rate gate, refusal detector, snapshot builder, message persistence with `encryptedContent` Bytes column.                                              |
| OpenAPI                 | `src/lib/openapi/registry.ts` + `src/lib/openapi/routes/` (23 modules, `index.ts` barrel)                                                                           | Source of truth for `docs/api/openapi.yaml`.                                                                                                                                             |
| Schema                  | `prisma/schema.prisma` (115 models)                                                                                                                                  | `cuid()` PKs, `snake_case` columns via `@map`, encrypted columns mostly under `*Encrypted` (search the file).                                                                            |
| Compose                 | `docker-compose.yml`                                                                                                                                                | `app` + `db`. Env-var whitelist under `environment:` — vars not listed never reach the container. `pull_policy: always` is load-bearing.                                                 |

`.planning/codebase/arch.md` carries the full annotated walk for every section.

## Security-relevant patterns

The v1.5.2 audit produced `.planning/security-audit-v1.5.2.md` and a stack of per-domain findings under `.planning/security-audit-findings/`. The patterns worth preserving on future churn:

- **Encryption: fail closed everywhere.** Missing keys, malformed JSON, unknown key ids — every path throws rather than silently writing plaintext. Operators rotating keys must keep the legacy entry in `ENCRYPTION_KEYS` until the rotation script reports zero remaining legacy rows. The script covers every `*Encrypted` column + `CoachMessage.encryptedContent` (Bytes) + `IntegrationStatus.lastError`.
- **SSRF: input-time `isPublicUrl` is the floor.** The helper `isPublicUrl()` in `src/lib/validations/notifications.ts` catches every IPv4 / IPv6 alt-notation class (octal / hex / decimal IPv4, IPv4-mapped IPv6, IPv6 ULA, CGNAT, link-local, loopback, metadata). Use it for every outbound URL that comes from a user / admin input. DNS rebinding and the redirect-follow gap remain as architectural follow-ups (issues #217 + #218). Until those land, every NEW outbound `fetch()` that touches a user-controlled host must pin `redirect: "manual"` and an `AbortSignal.timeout`.
- **Outbound egress goes through `safeFetch`.** `src/lib/safe-fetch.ts` is the one documented egress entry (`redirect: "manual"` + `AbortSignal.timeout(15_000)` defaults; opt into the connect-time DNS-rebinding pin with `requirePublicHost: true` for any operator- or user-supplied host). The in-repo ESLint rule `healthlog/safe-fetch-required` (set to `error`) bans raw `fetch(` under `src/lib/` + `src/app/` outside the wrapper internals and test files; same-origin relative-path (`/api/…`) client fetches are exempt by construction.
- **Rate limits live in Postgres.** `src/lib/rate-limit.ts` uses a single atomic SQL upsert returning `{count, reset_at}`. Multi-instance correctness is structural. Bucket-key convention: `<surface>:${identifier}` where identifier is `userId` for authenticated routes and the trusted-proxy IP for anonymous. Anonymous auth surfaces use `checkAuthSurfaceRateLimit(...)` so a trust-violation collapses every anonymous caller into a single tight bucket rather than a free-for-all under the unknown-IP bucket.
- **Webhooks: shared-secret + `timingSafeEqual` + per-source rate limit BEFORE secret verification.** Withings, Telegram, the Coolify deploy webhook, and the CSP report endpoint all follow this exact pattern. The Withings path-segment secret is scrubbed from `http.path` / `http.route` by `redactSecrets()` via the `PATH_SECRET_PATHS` registry in `src/lib/logging/redact.ts:40`.
- **Idempotency keys are user-scoped, length-bounded, and refuse to cache secret-shaped responses.** `src/lib/idempotency.ts`. A client cannot replay another user's idempotency key (composite unique index by `userId_key_method_path`). The cache helper refuses to persist a response body containing `hlk_` / `hlr_` / `sk-` patterns even if a future caller wraps an auth endpoint by mistake.
- **CSP: strict, per-request nonce, surgical `connect-src`.** Production CSP gates third-party hosts to the routes that need them — AI hosts only on `/settings/ai/*`, `wbsapi.withings.net` only on `/settings/integrations/withings/*` + `/api/withings/*`. Exactly one `dangerouslySetInnerHTML` in the tree (the theme bootstrap in `src/app/layout.tsx`, nonce-bound, file-literal content). No markdown library installed anywhere; Coach / briefing / insights render as plain React text children. Don't add one without a security review of the renderer's HTML-allow defaults.
- **No CORS headers anywhere.** Same-origin-only by construction. Adding `Access-Control-Allow-Origin: *` anywhere would silently open every authenticated endpoint to cross-origin POST; webhook routes accept cross-origin POSTs but they authenticate by header secret, not cookie.
- **Redaction at the egress boundary, not at the call site.** `redactSecrets()` + `redactSensitiveFields()` + `redactOptional()` are applied centrally in `WideEventBuilder` and `reportToGlitchtip`. Don't add new redactor calls in handler bodies — extend the central denylists in `src/lib/observability/redact-payload.ts` and `src/lib/logging/redact.ts`.

## Self-hosting gotchas

These keep tripping operators; they're worth knowing before you push something that breaks them.

- **`SESSION_COOKIE_SECURE`** controls the `Secure` flag on every cookie the app issues. Unset → flag tracks `NODE_ENV === "production"`. Set to `false` for LAN / Tailscale / VPN-only HTTP self-hosts where the operator deliberately serves plain HTTP. Set to `true` to force the flag even in dev. The compose `environment:` block must list it explicitly — vars not on the whitelist don't reach the container even when `.env` has them. v1.5.2 closed the missing-whitelist regression.
- **`pull_policy: always`** in `docker-compose.yml` is load-bearing. Without it Docker keeps a stale `:latest` digest cached and silently skips the registry round-trip on `compose up`.
- **`ENCRYPTION_KEYS` map vs legacy `ENCRYPTION_KEY`.** The map (`{"v1":"<hex>","v2":"<hex>"}` + `ENCRYPTION_ACTIVE_KEY_ID=v2`) is the modern path. The legacy single-key env var stays accepted as `v1`. Rotation playbook lives at `docs/ops/encryption-key-rotation.md`; do NOT drop a key from the map before the rotation script reports zero remaining rows on that key.
- **GeoLite2 databases.** Operators run `scripts/fetch-geolite2.sh` with a MaxMind licence key before `docker build`; the image bakes the MMDBs into `/opt/geolite2/`. Without them the resolver falls back to online `ipwho.is` and the admin login overview surfaces "unknown" for offline lookups.
- **APNs `.p8` key.** v1.4.47.x established `APNS_KEY_B64` as the env-var contract — pasting the PEM body verbatim through Coolify's `env_file` mangled the literal newlines. The key must be scoped "Sandbox & Production" in the Apple Developer Portal; a Sandbox-only key fails with `BadEnvironmentKeyInToken` on production builds.

## iOS handoff

The native SwiftUI client lives in a separate repository and rides public beta via TestFlight. Backend contract the iOS app speaks against is locked in `docs/api/openapi.yaml` and has been continuously validated since v1.4.23. Coordination notes worth knowing on the backend side:

- `POST /api/measurements/batch` recognises `externalId` values starting with `stats:` (e.g. `stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD`) as **overwrites** — a re-post replaces the row's value / unit / measuredAt / externalSourceVersion / deviceType / sleepStage. Every other externalId prefix (`uuid-*`, opaque HK identifiers) keeps the first-write-wins immutable contract because each sample is a canonical reading. Per-entry status field carries `"updated"` for an overwrite vs `"inserted"` for a fresh row.
- Refresh-token rotation is per-device; reuse-detection revokes the family scoped to that device.
- `requireAdmin()` is cookie-only by construction — a Bearer token, even with `["*"]` scope, cannot reach `/api/admin/*`. The iOS app is not an admin client.
- The `clientManaged` opt-in on `PATCH /api/auth/me/notification-prefs` suppresses server-side `MEDICATION_REMINDER` APNs for clients that manage their own local reminders. The cron skips dose-due APNs when the flag is `true` and emits a `medication_reminder.suppressed_client_managed` wide-event annotation per skip.
- `push_attempts` table holds the last 90 days of APNS / Web-Push / Telegram / NTFY delivery attempts (channel + eventType + result + reason + createdAt). The admin diagnostic endpoint at `/api/admin/notifications/diagnostic` surfaces masked device tokens + channel state + last 20 attempts for the calling user.
- Any request / response schema change must regen `docs/api/openapi.yaml` and commit the result. CI fails on drift.
- The iOS app signs in via the native OIDC SSO handoff **or** password/passkey. The native SSO leg: the app opens `GET /api/auth/oidc/login?client=native&code_challenge=<S256>` in an `ASWebAuthenticationSession`, the callback returns to the fixed compiled-in scheme `healthlog://oidc-callback` with a one-time `code=hlh_…` (or an `mfa_ticket` when the account has a second factor), and the app exchanges the code at `POST /api/auth/oidc/native/token` for the standard native bundle (`src/lib/auth/oidc-native-handoff.ts`). The `healthlog://` scheme is a compile-time constant — no `redirect_uri` param, no env allowlist (the open-redirect class is removed by construction). The token pair NEVER rides a URL; only the opaque handoff code / MFA ticket do. The SSO login can never satisfy `requireFreshMfa` step-up — the native transport is Bearer and `requireFreshMfa` is cookie-only, and even the web path sets `mfaVerifiedAt` only from the app's own factor. `OIDC_ONLY=true` is now supported for iOS but requires the app build that ships this flow; an older password/passkey-only build is locked out. The MFA-verify and `/api/auth/refresh` routes that complete/rotate an OIDC login are deliberately not OIDC-only-blocked.

## DO-NOTs

- **No `--no-verify` on commits.** If a pre-commit hook fails, fix the cause; never bypass.
- **No `--no-gpg-sign` unless explicitly asked.**
- **No force-push to `main`** (or to release branches, by extension).
- **No destructive git operations as shortcuts.** `git reset --hard`, `git clean -fd`, `git checkout .` etc. only when the maintainer asked or the state is unambiguously local-only.
- **No assistant / planning vocabulary in any committed artefact** — see Voice and privacy above.
- **No personal names** — the maintainer's, a reporter's, or anyone else's — in any committed artefact, including code comments referring to "the user who reported issue #X".
- **No secret-shaped strings in `.env.example` or git history.** Pre-existing scan shows clean.
- **No markdown library in dependencies.** Coach + briefing + insights render as React text children for XSS reasons; adding one is a security decision, not a UX one.
- **No `Access-Control-Allow-Origin` headers** anywhere except the documented webhook surfaces — and those authenticate via header secret, not cookie.
- **No `pnpm tsx scripts/foo.ts` in production.** The standalone image strips `tsx`. One-shot scripts run via `pnpm dlx tsx`; recurring tasks belong on pg-boss.
- **No backwards-compatibility shims for hypothetical callers.** When a change is clean, make it cleanly; do not leave dead branches "in case" something we don't ship needs them.

## Pointers

| What                                        | Where                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public face                                 | `README.md`                                                                                                                                         |
| Release history                             | `CHANGELOG.md`                                                                                                                                      |
| Codebase audit (v1.5.2)                     | `.planning/codebase/{tech,arch,quality,concerns}.md`                                                                                                |
| Security audit (v1.5.2)                     | `.planning/security-audit-v1.5.2.md` + `.planning/security-audit-findings/*`                                                                        |
| Operator runbooks                           | `docs/ops/` (deploy, encryption-key-rotation, env-check, backup-restore, migrations)                                                                |
| Self-hosting guide                          | `docs/self-hosting/`                                                                                                                                |
| Public API contract                         | `docs/api/openapi.yaml`                                                                                                                             |
| Architecture diagrams                       | `docs/diagrams/` (rendered through `docs.healthlog.dev`)                                                                                            |
| iOS coordination notes                      | `.planning/ios-coord/`                                                                                                                              |
| Maintainer working notes                    | `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/STATE.md` (gitignored release scratch lives alongside; the patterns are in `.gitignore`) |
| Personal preferences + collaboration memory | `~/.claude/projects/-Users-marc-Projects-HealthLog/memory/MEMORY.md` (local to the maintainer's working copy; not in the repo)                      |

## Agent context hygiene (ECONNRESET / oversized-request prevention)

- **NEVER read `src/generated/**`** — Prisma-generated client (~9 MB, 83 files incl. a 224 KB+ inline schema). Reading/grepping it explodes the request context → 10-min "cogitations" + `ECONNRESET`on large turns. Regenerate via`pnpm prisma generate`if needed; never open it. (Enforced via`.claude/settings.local.json` Read-deny.)
- Avoid bulk-reading other large artifacts: `pnpm-lock.yaml`, `CHANGELOG.md`, `messages/*.json`, `docs/api/openapi.yaml` — grep narrowly instead of full reads.
- For very large multi-agent actions: cap concurrent sub-agents (many simultaneous streaming requests + big context is the worst combo for connection resets). When on a VPN (Tailscale MTU 1280 / iCloud Private Relay), large requests can hit MTU black-holes — disable the tunnel for heavy sessions.
