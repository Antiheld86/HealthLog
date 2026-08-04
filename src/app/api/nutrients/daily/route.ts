/**
 * `GET /api/nutrients/daily?nutrient=<code>&days=N` — per-day summed
 * series for one nutrient, plus its resolved EFSA reference (v1.29).
 *
 * Feeds the `/insights/nutrients` hydration + caffeine charts: a dense
 * day-bucketed series (one row per calendar day in the window, 0 for a
 * day with no logged data) summed ACROSS sources — a day can carry an
 * APPLE_HEALTH row and a MANUAL row since migration 0249, and the
 * chart shows one honest bar per day. The window is anchored to the
 * caller's own local "today" (`User.timezone`), not a UTC floor —
 * unlike the coarser window on `GET /api/nutrients`, a chart with a
 * one-day edge wobble reads as a visible bug.
 *
 * The reference resolves against the caller's profile sex (from the
 * session's own `User` row — no extra query) and is `null` when the
 * profile has no sex on file, matching the catalog's own contract:
 * omit, never guess. Module-gated like every other nutrients route.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { binaryReferenceSex } from "@/lib/profile/sex";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  NUTRIENT_CATALOG,
  resolveNutrientReference,
} from "@/lib/nutrients/catalog";
import { nutrientDailyQuerySchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = nutrientDailyQuerySchema.safeParse({
    nutrient: request.nextUrl.searchParams.get("nutrient") ?? undefined,
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.daily.invalid",
    });
  }
  const { nutrient, days } = parsed.data;
  const definition = NUTRIENT_CATALOG[nutrient];

  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const todayKey = userDayKey(new Date(), userTz);
  const sinceKey = shiftDateKey(todayKey, -(days - 1));

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId: user.id, nutrient, day: { gte: sinceKey } },
    select: { day: true, amount: true },
  });

  // Sum across sources within a day BEFORE bucketing — the same fold
  // `GET /api/nutrients` applies (migration 0249 note there).
  const sumByDay = new Map<string, number>();
  for (const row of rows) {
    sumByDay.set(row.day, (sumByDay.get(row.day) ?? 0) + row.amount);
  }

  const daySeries: Array<{ day: string; amount: number }> = [];
  for (let i = 0; i < days; i++) {
    const key = shiftDateKey(sinceKey, i);
    daySeries.push({ day: key, amount: sumByDay.get(key) ?? 0 });
  }

  const sex = binaryReferenceSex(user.gender);
  const reference = resolveNutrientReference(nutrient, sex);

  annotate({
    action: { name: "nutrient.daily.read" },
    meta: { nutrient, window_days: days, row_count: rows.length },
  });

  return apiSuccess({
    nutrient,
    unit: definition.unit,
    windowDays: days,
    days: daySeries,
    reference,
  });
});
