# HealthLog API Spec

`openapi.yaml` is the OpenAPI 3.1 description for the HealthLog
Next.js API and the source of truth for the native iOS client's DTO
codegen. The file is **generated**: `pnpm openapi:generate` emits it
from the Zod registry under `src/lib/openapi/` (`registry.ts` plus the
route modules in `src/lib/openapi/routes/`). Do not edit the YAML by
hand; the next generation overwrites it, and CI (`openapi:check`)
fails the build when the committed YAML drifts from the registry.

The MCP server is documented separately — it is a distinct contract over
JSON-RPC, not part of the REST OpenAPI spec:

- [`mcp-capabilities.md`](./mcp-capabilities.md) — the tool, resource, and
  prompt catalogue, the grounding contract, and the write model.
- [`mcp-skills.md`](./mcp-skills.md) — building a connector or skill on
  top of it.
- [`../self-hosting/mcp.md`](../self-hosting/mcp.md) — enabling and
  connecting the surface (operator guide).

## Preview locally

Open an interactive Redoc preview in your browser:

```bash
npx @redocly/cli preview docs/api/openapi.yaml
```

Generate static HTML for sharing:

```bash
npx @redocly/cli build-docs docs/api/openapi.yaml --output docs/api/index.html
```

## Validate

```bash
npx @redocly/cli lint docs/api/openapi.yaml
```

The spec is expected to be lint-clean (errors = 0). Warnings such as
`no-server-example.com` for the localhost dev server are tolerated;
re-run the lint to see what it produces against the current file
before treating a warning as a regression.

## Layout

- **`info`** — title, description, and `version` mirrored automatically
  from `package.json` at generation time. Never bump it by hand.
- **`servers`** — `https://healthlog.example.com` as the self-hosted
  placeholder plus `http://localhost:3000` for local development.
- **`tags`** — domain groupings; the current set lives at the top of
  the generated file (`Auth`, `Measurements`, `Medications`, `Mood`,
  `Analytics`, `Insights`, `Consent`, `Dashboard`, `Notifications`,
  `Devices`, `Export`, `Sync`, `Cycle`, `MeasurementReminders`,
  `Labs`, `Illness`, `Documents`, `Records`, `Admin`, `Meta`,
  `Retired`).
- **`securitySchemes`**:
  - `bearerAuth` — long-lived `hlk_*` API tokens issued via `POST /api/tokens`.
    Required on `/api/ingest/medication`.
  - `sessionCookie` — HttpOnly `healthlog_session` cookie set by the
    password and passkey login flows. Used by the web app and any iOS
    client running inside a web view.
- **`components.schemas`** — DTOs for the documented routes plus the
  underlying Prisma models (e.g. `Measurement`, `Medication`,
  `MedicationIntakeEvent`, `MoodEntry`, `User`, `DashboardLayout`,
  `ApiEnvelope`, `ApiError`).
- **`paths`** — the client-facing REST surface. Not every
  `src/app/api/**/route.ts` is in the contract: most `/api/admin/*`
  routes, the OAuth connect/callback legs, and the webhook surfaces
  are not documented here. The `Retired` tag lists removed paths that
  answer `410 Gone`.

## Conventions

- Successful responses use the envelope `{ data, error: null }`.
- Error responses use the envelope `{ data: null, error: '<message>' }`.
- Pagination uses `limit` + `offset` query parameters and a
  `meta: { total, limit, offset }` block on the response.
- All timestamps are ISO 8601 / RFC 3339 (`format: date-time`) in UTC.
- IDs are CUIDs (opaque strings).

## Updating the spec

When adding or changing routes:

1. Update the relevant route handler under `src/app/api/**/route.ts`.
2. Change the Zod schemas and their `.meta()` registrations under
   `src/lib/openapi/` (registry entry plus the matching module in
   `src/lib/openapi/routes/`). Keep `operationId` camelCase and
   stable; the iOS codegen keys off it.
3. Run `pnpm openapi:generate` and commit the regenerated
   `openapi.yaml` alongside the schema change. CI's `openapi:check`
   fails on drift.
4. Never edit the YAML directly and never bump `info.version` by
   hand; the version follows `package.json` at generation time.
