# v1.34.1 dated dependency audit

## Decision

**PASS for the locked v1.34.1 no-update scope.** The 2026-07-29 audit has no
production-reachable High or unresolved Medium advisory outside the explicitly
accepted dependency deferral. No dependency, lockfile, workspace setting, or
installed package was changed.

This is not a claim that the dependency graph is advisory-free. The captured
registry response contains 19 advisory entries: 9 High, 9 Moderate, 1 Low.
Fourteen are additional build, lint, test, or development-tool transitives. The
other five are exactly the locked `hono`, `@hono/node-server`, and `valibot`
Moderate deferral. All remain open for the post-v1.34.1 dependency follow-up.

## Immutable capture

| Field | Value |
| --- | --- |
| Captured UTC | `2026-07-29T13:15:08Z` |
| Captured local | `2026-07-29T15:15:08+0200` |
| Command | `pnpm audit --json` |
| pnpm | `11.15.1` |
| Registry/database | `https://registry.npmjs.org/`; advisory records link to the GitHub Advisory Database. pnpm JSON exposes no immutable database revision. |
| Exit code | `1` (advisories present) |
| External directory | `/tmp/healthlog-pnpm-audit-20260729.Epa5Zn` |
| Raw JSON | `/tmp/healthlog-pnpm-audit-20260729.Epa5Zn/pnpm-audit.json` |
| Raw JSON SHA-256 | `a49c2ef9ff9d1511822ffe166a0b643dadcdf22d39c349da8a727eb638194d8e` |
| Raw JSON size | `74,810` bytes |
| Dependency metadata | 541 dependencies, 824 dev dependencies, 282 optional dependencies, 1,449 total |

Raw audit material remains outside the repository and contains no application
secret. The external path is ephemeral and is recorded for this execution
session rather than treated as a durable release artifact.

## Exact advisory snapshot

“Roots” are the first dependency after the workspace root across every exact
path in the raw JSON. “Paths” is the number of unique full dependency paths.
The raw capture is authoritative for every unabridged chain.

| Advisory | Package | Severity | Installed | Registry fixed range | Roots | Paths |
| --- | --- | --- | --- | --- | --- | ---: |
| GHSA-23c5-xmqv-rm74 | `minimatch` | High | `3.1.3` | `>=3.1.4` | `eslint`, `eslint-config-next` | 78 |
| GHSA-25h7-pfq9-p65f | `flatted` | High | `3.3.3` | `>=3.4.0` | `eslint`, `eslint-config-next` | 26 |
| GHSA-rf6f-7fwh-wjgh | `flatted` | High | `3.3.3` | `>=3.4.2` | `eslint`, `eslint-config-next` | 26 |
| GHSA-f886-m6hf-6m8v | `brace-expansion` | Moderate | `1.1.12` | `>=1.1.13` | `eslint`, `eslint-config-next` | 78 |
| GHSA-g7r4-m6w7-qqqr | `esbuild` | Low | `0.27.7` | `>=0.28.1` | `@vitejs/plugin-react`, `@vitest/coverage-v8`, `vitest` | 5 |
| GHSA-h67p-54hq-rp68 | `js-yaml` | Moderate | `4.1.1` | `>=4.1.2` | `eslint`, `eslint-config-next` | 26 |
| GHSA-96hv-2xvq-fx4p | `ws` | High | `7.5.10` | `>=7.5.11` | `@next/bundle-analyzer` | 1 |
| GHSA-f38q-mgvj-vph7 | `protobufjs` | Moderate | `7.6.2` | `>=7.6.3` | `@testcontainers/postgresql`, `testcontainers` | 6 |
| GHSA-3jxr-9vmj-r5cp (ID 1123896) | `brace-expansion` | High | `2.1.1` | `>=2.1.2` | `@testcontainers/postgresql`, `testcontainers` | 2 |
| GHSA-3jxr-9vmj-r5cp (ID 1123897) | `brace-expansion` | High | `1.1.12`, `1.1.14` | `>=1.1.16` | `eslint`, `eslint-config-next` | 82 |
| GHSA-52cp-r559-cp3m | `js-yaml` | High | `4.1.1` | `>=4.3.0` | `eslint`, `eslint-config-next` | 26 |
| GHSA-j3f2-48v5-ccww | `protobufjs` | Moderate | `7.6.2` | `>=7.6.5` | `@testcontainers/postgresql`, `testcontainers` | 6 |
| GHSA-xgm2-5f3f-mvvc | `hono` | Moderate | `4.12.25` | `>=4.12.27` | `@modelcontextprotocol/sdk`, `@prisma/client`, `prisma`, `shadcn` | 8 |
| GHSA-frvp-7c67-39w9 | `@hono/node-server` | Moderate | `1.19.14` | `>=2.0.5` | `@modelcontextprotocol/sdk`, `@prisma/client`, `prisma`, `shadcn` | 4 |
| GHSA-hvrm-45r6-mjfj | `hono` | Moderate | `4.12.25` | `>=4.12.27` | `@modelcontextprotocol/sdk`, `@prisma/client`, `prisma`, `shadcn` | 8 |
| GHSA-w62v-xxxg-mg59 | `hono` | Moderate | `4.12.25` | `>=4.12.27` | `@modelcontextprotocol/sdk`, `@prisma/client`, `prisma`, `shadcn` | 8 |
| GHSA-r28c-9q8g-f849 | `postcss` | High | `8.5.14` | `>=8.5.18` | `@tailwindcss/postcss` | 1 |
| GHSA-5qjj-4xww-7phc | `valibot` | Moderate | `1.2.0` | `>=1.4.2` | `@prisma/client`, `prisma` | 2 |
| GHSA-mh99-v99m-4gvg | `brace-expansion` | High | `1.1.12`, `1.1.14`, `2.1.1`, `2.1.2`, `5.0.7` | `>=5.0.8` | `@testcontainers/postgresql`, `eslint`, `eslint-config-next`, `shadcn`, `testcontainers` | 100 |

Representative full paths, with all variants retained in the raw JSON:

- lint: `. > eslint > minimatch` and
  `. > eslint-config-next > ... > eslint > ...`
- test: `. > testcontainers > dockerode > protobufjs` and
  `. > testcontainers > archiver > ... > brace-expansion`
- build/analyse: `. > @tailwindcss/postcss > postcss` and
  `. > @next/bundle-analyzer > ws`
- locked Hono family: `. > @modelcontextprotocol/sdk > hono`,
  `. > @modelcontextprotocol/sdk > @hono/node-server`, and the
  `prisma > @prisma/dev` / `shadcn > @modelcontextprotocol/sdk` variants
- locked Valibot: `. > prisma > @prisma/dev > valibot` and the same chain
  reached through `@prisma/client > prisma`

## Delta from the older five-Moderate note

The PRD's five-entry description remains exact for the named deferral:

1. three `hono` Moderate advisories:
   GHSA-xgm2-5f3f-mvvc, GHSA-hvrm-45r6-mjfj, and
   GHSA-w62v-xxxg-mg59;
2. one `@hono/node-server` Moderate advisory:
   GHSA-frvp-7c67-39w9;
3. one `valibot` Moderate advisory:
   GHSA-5qjj-4xww-7phc.

The dated registry snapshot is broader than that older shorthand by 14 entries:
9 High, 4 Moderate, and 1 Low across lint, build/analyse, Vitest/Vite, and
Testcontainers transitives. This is the expected date-sensitive delta already
anticipated by `01-SECURITY-RESEARCH.md`; it must not be collapsed back to
“five total advisories.”

## Reachability and release treatment

- The additional `minimatch`, `flatted`, `brace-expansion`, and `js-yaml`
  paths are ESLint/configuration tooling. Their ReDoS, recursion, expansion,
  and YAML-complexity attack preconditions do not accept application runtime
  input.
- `protobufjs` and its `brace-expansion` paths are under Testcontainers;
  `ws` is under the bundle analyser; `esbuild` is under Vite/Vitest tooling.
  These are test/development paths, not deployed HealthLog request handlers.
- `postcss` is a build-time Tailwind path. The repository does not compile
  attacker-supplied source maps at runtime.
- The accepted Hono advisories concern adapters/utilities not used by the
  application imports (`API Gateway v1`, Hono JSX context/`cx()`, and the
  Node-server Windows `serve-static` path). HealthLog's MCP code imports the
  MCP SDK's server/transport interfaces, not those vulnerable sinks.
- `valibot` is reached through Prisma's development tool graph, not a
  HealthLog runtime validation path.
- Availability-only dependency issues and third-party dependency internals are
  outside the reportable application-security scope in `SECURITY.md`, but the
  advisories remain tracked rather than called fixed.

Therefore the dated expansion introduces no production-reachable High or
unresolved Medium release blocker. The explicit v1.34.1 decision remains:
accept/document the five named Moderate entries and do not mutate dependency
state in this release. Review all 19 entries together in the post-release
dependency update so an override does not silently fix one path while leaving
sibling paths unresolved.

## No-change proof

The three dependency working files still match the execution baseline:

| File | SHA-256 |
| --- | --- |
| `package.json` | `7a6dbc488beaf210808bf959b84717be462781f2aca74a5fbc157699d7b3668a` |
| `pnpm-lock.yaml` | `d9fa8c99e86eb4977f55395c43ca2c1781de26400870003c783e7112405970d6` |
| `pnpm-workspace.yaml` | `979d04c351ba838e6c8da97aa34545c9a76513710f86d84f6c07d1289d0cd054` |

Their binary Git patch SHA-256 remains
`b1206decc31f09b621676ac558919caf23a2190869d948fbc585fa3f38170f95`.
No install, update, override change, audit fix, or lockfile normalization ran.
