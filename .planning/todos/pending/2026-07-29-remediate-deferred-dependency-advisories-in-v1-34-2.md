---
created: 2026-07-29T14:44:48.825Z
title: Remediate deferred dependency advisories in v1.34.2
area: tooling
files:
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-DEPENDENCY-AUDIT.md
---

## Problem

The dated v1.34.1 audit reports 19 transitive advisories: 9 High, 9 Moderate
and 1 Low. The High records are currently confined to lint, test, build and
bundle-analysis tooling. Five known Moderate Hono/@hono/node-server/Valibot
records remain in the production dependency graph, although HealthLog does not
directly import their affected adapters, JSX utilities or flattening paths.

The release owner explicitly decided not to churn dependencies during the
already-gated v1.34.1 point release. The exact advisory IDs, installed versions,
roots and reachability assessment are recorded in `01-DEPENDENCY-AUDIT.md`.

## Solution

Prepare v1.34.2 immediately after v1.34.1:

1. Upgrade the direct roots or use the narrowest safe transitive resolution for
   Hono, @hono/node-server, Valibot, ESLint, Testcontainers, Tailwind/PostCSS,
   bundle analyzer and Vite/esbuild.
2. Do not apply blind overrides where the owning package has not declared a
   compatible range.
3. Re-run MCP/Prisma boundary tests, all unit and real-PostgreSQL integration
   suites, production build/bundle, desktop/mobile Playwright and a final
   Standard Codex Security working-tree scan.
4. Re-run `pnpm audit --json` and reconcile every advisory by ID and resolved
   production reachability.
5. Preserve the intentional `@openai/codex-security` installation while
   reviewing the package/lock/workspace delta independently from v1.34.1.
