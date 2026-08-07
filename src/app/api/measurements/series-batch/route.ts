/**
 * v1.18.6 — GET /api/measurements/series-batch
 *
 * Batched, rollup-backed daily-series endpoint. Returns ALL requested
 * measurement types in ONE response so the dashboard's chart row does a
 * single round-trip instead of one self-fetch per chart (audit finding
 * #2 — the per-chart fan-out).
 *
 * Query: `types` (comma-list of `MeasurementType`), `from`, `to`. Always
 * reads `aggregate=daily` through the rollup tier (`source=rollup`) via
 * the shared `readDailySeries` reader — the SAME path
 * `GET /api/measurements?aggregate=daily&source=rollup` uses, so the
 * per-type series are byte-identical between the two endpoints. Internal
 * per-type reads are capped with `p-limit` to protect the shared Prisma
 * pool.
 *
 * Sleep is deliberately NOT included: SLEEP_DURATION rides a per-night
 * stage reconstruction (`/api/measurements/series?kind=sleep`), not the
 * rollup tier, so the dashboard sleep chart stays on its existing
 * `/series` call. Passing `SLEEP_DURATION` here yields an empty series
 * for that key (the rollup carries no useful per-night collapse) — the
 * client keeps sleep on the dedicated route.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { returnAllZodIssues } from "@/lib/api-response";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readSeriesBatch } from "@/lib/measurements/series-batch-read";
import {
  seriesBatchQuerySchema,
  SERIES_BATCH_MAX_TYPES,
} from "@/lib/validations/series-batch";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = seriesBatchQuerySchema.safeParse(params);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  const { types, from, to } = parsed.data;

  // Shared core: priority ladder once, `p-limit(4)` per-type fan-out, per-type
  // fault isolation to `[]`. The RSC dashboard prefetch calls the same
  // function so the two paths never drift.
  const { series, degradedTypes } = await readSeriesBatch(
    user.id,
    types,
    from,
    to,
  );

  const seriesLists = Object.values(series);
  annotate({
    action: { name: "measurement.series.batch" },
    meta: {
      type_count: seriesLists.length,
      total: seriesLists.reduce((sum, rows) => sum + rows.length, 0),
      degraded_types: degradedTypes,
    },
  });

  return apiSuccess({ series });
});

// Re-export the cap so the OpenAPI table + tests share the constant.
export { SERIES_BATCH_MAX_TYPES };
