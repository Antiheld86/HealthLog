/**
 * OpenAPI route table — dashboard widget layout (`/api/dashboard/widgets`).
 *
 * v1.32.21 (R5a) — this endpoint was ENTIRELY absent from the registry
 * even though it is the reference implementation for the optimistic-
 * concurrency token contract the native client is being asked to adopt
 * (issue #581, shipped v1.32.16). Documenting it here closes that gap: the
 * contract iOS validates against now carries the `baseUpdatedAt` request
 * field, the `updatedAt` response token, and the 409 conflict envelope.
 *
 * The schema mirrors the inline Zod shape in
 * `src/app/api/dashboard/widgets/route.ts`; the id sets are imported from
 * the single-source `@/lib/dashboard-layout` module so the contract cannot
 * drift. Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  SCORE_RING_IDS,
  HERO_RING_IDS,
} from "@/lib/dashboard-layout";
import {
  dataEnvelope,
  stdResponses,
  baseUpdatedAtField,
  conflictResponse409,
} from "./shared";

const dashboardWidgetConfig = z.object({
  id: z.enum(DASHBOARD_WIDGET_CATALOGUE_IDS),
  visible: z.boolean(),
  tileVisible: z.boolean().optional(),
  order: z.number().int().min(0).max(99),
});

const dashboardChartOverlayPrefs = z.object({
  showTrendIndicator: z.boolean(),
  showTrendArrow: z.boolean(),
  showTargetRange: z.boolean(),
  comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
  rangePoints: z
    .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
    .optional(),
});

// The layout shape shared by GET/PUT/DELETE. `widgets` (and the other
// preserve-when-absent fields) are optional on the wire: the Settings
// instant score-ring PUT omits `widgets` entirely so the server carries
// forward whatever is currently stored (issue #581).
const dashboardLayoutSchema = z
  .object({
    version: z.literal(1),
    widgets: z.array(dashboardWidgetConfig).min(1).max(50).optional(),
    comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
    chartOverlayPrefs: z
      .partialRecord(z.enum(CHART_OVERLAY_KEYS), dashboardChartOverlayPrefs)
      .optional(),
    selectedScoreRings: z.array(z.enum(SCORE_RING_IDS)).max(3).optional(),
    heroRingOrder: z.array(z.enum(HERO_RING_IDS)).max(4).optional(),
  })
  .meta({
    id: "DashboardLayoutBody",
    description:
      "Per-user dashboard widget layout. `widgets` is the ordered tile/chart list (each with a visibility flag plus the independent `tileVisible` strip-tile flag); `comparisonBaseline`, `chartOverlayPrefs`, `selectedScoreRings`, and `heroRingOrder` are the additive dashboard-preference fields. Every field except `version` is optional on input and preserve-when-absent: an omitted field is carried forward from the stored layout rather than reset, so a single-surface PUT (e.g. the instant hero-ring toggle, which omits `widgets`) can never clobber a choice made on another surface. Widget ids are the closed 27-id catalogue (16 web + 11 iOS-only); unknown ids are dropped before validation.",
  });

const dashboardLayoutPutBody = dashboardLayoutSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "DashboardLayoutPutBody",
    description:
      "PUT body for the dashboard layout — the layout fields plus the optional optimistic-concurrency base token (`baseUpdatedAt`). Omit the token for the legacy unconditional write.",
  });

const dashboardLayoutResult = dashboardLayoutSchema
  .extend({
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque.",
      ),
  })
  .meta({
    id: "DashboardLayoutResult",
    description:
      "Resolved dashboard layout plus the optimistic-concurrency `updatedAt` token.",
  });

export const dashboardWidgetPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/dashboard/widgets": {
    get: {
      tags: ["Dashboard"],
      summary: "Read the calling user's dashboard widget layout",
      description:
        "Returns the resolved effective layout (defaults merged in if the user has not customised it) plus the optimistic-concurrency `updatedAt` token.",
      responses: {
        "200": {
          description:
            "The resolved layout (custom or default) plus its token.",
          content: {
            "application/json": {
              schema: dataEnvelope(dashboardLayoutResult, "DashboardLayout"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Dashboard"],
      summary: "Replace the calling user's dashboard widget layout",
      description:
        "Persists the layout with preserve-when-absent semantics and returns the normalised layout plus the advanced `updatedAt` token. Optimistic concurrency (v1.32.16): send `baseUpdatedAt` (the token from a prior read) and the write 409s if the stored row changed since — so a committed Save can never be silently reverted by a later request that started from an older snapshot; omit it for the legacy unconditional write. Invalid bodies return the multi-issue 422 envelope.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: dashboardLayoutPutBody },
        },
      },
      responses: {
        "200": {
          description:
            "Layout saved; the normalised layout plus the advanced token is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardLayoutResult,
                "DashboardLayoutSaved",
              ),
            },
          },
        },
        ...conflictResponse409("Dashboard layout", "dashboard_layout_conflict"),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Dashboard"],
      summary: "Reset the calling user's dashboard widget layout",
      description:
        "Clears the persisted layout and returns the default layout. Idempotent.",
      responses: {
        "200": {
          description: "Layout reset; the default layout is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardLayoutResult,
                "DashboardLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
