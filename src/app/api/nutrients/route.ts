/**
 * `GET /api/nutrients?days=N` — synced-nutrient window summary (v1.28).
 *
 * Feeds the read-only settings card (Settings → Sources): per nutrient
 * with data inside the window, the latest synced day + total and the
 * count of days carrying data — the smallest honest surface for "what
 * does the server hold". Catalog order, no pagination (≤ 26 rows).
 * Module-gated like the ingest path: 403 `module.disabled` when the
 * opt-in `nutrients` module is off. `userId` is narrowed from auth.
 *
 * `lastAttempt` (v1.34.3): non-null only when the window is empty AND the
 * most recent `nutrient.batch.ingest` audit row shows a call that landed
 * nothing, so `/insights/nutrients` can say a sync arrived and why instead
 * of a bare "no data yet". See the lookup below for the AuditLog-retention
 * coupling this introduces.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { NUTRIENT_CODES, isNutrientCode } from "@/lib/nutrients/catalog";
import { nutrientOverviewQuerySchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

/** Highest-count skip reason; ties break on this fixed declaration order. */
const SKIP_REASON_PRIORITY = [
  "unit_mismatch",
  "value_out_of_range",
  "day_invalid",
  "upsert_failed",
] as const;

interface LastIngestDetails {
  inserted: number;
  updated: number;
  skipped: number;
  skippedByReason: Record<string, number>;
}

/**
 * `AuditLog.details` is a free-form JSON string; parse it back into the
 * shape `nutrient.batch.ingest` (`src/app/api/nutrients/batch/route.ts`)
 * writes, rejecting anything that doesn't match rather than trusting the
 * blob.
 */
function parseLastIngestDetails(raw: string | null): LastIngestDetails | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const { inserted, updated, skipped } = obj;
  if (
    typeof inserted !== "number" ||
    typeof updated !== "number" ||
    typeof skipped !== "number"
  ) {
    return null;
  }
  const skippedByReason: Record<string, number> = {};
  const rawByReason = obj.skippedByReason;
  if (rawByReason && typeof rawByReason === "object") {
    for (const [reason, count] of Object.entries(
      rawByReason as Record<string, unknown>,
    )) {
      if (typeof count === "number") skippedByReason[reason] = count;
    }
  }
  return { inserted, updated, skipped, skippedByReason };
}

function pickTopSkipReason(byReason: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const reason of SKIP_REASON_PRIORITY) {
    const count = byReason[reason] ?? 0;
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = nutrientOverviewQuerySchema.safeParse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.read.invalid",
    });
  }
  const { days } = parsed.data;

  // v1.30 (DATAINT L4) — window floor anchored on the caller's own local
  // "today" (`User.timezone`), mirroring the sibling `GET
  // /api/nutrients/daily` route. The stored `day` is a local-timezone key,
  // so a UTC floor was off by up to a calendar day at the window edge for
  // any non-UTC user.
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const todayKey = userDayKey(new Date(), userTz);
  const since = shiftDateKey(todayKey, -(days - 1));

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId: user.id, day: { gte: since } },
    orderBy: [{ nutrient: "asc" }, { day: "desc" }],
    select: { nutrient: true, unit: true, day: true, amount: true },
  });

  // v1.29 — `source` joined the PK (migration 0249): a day can now carry
  // an APPLE_HEALTH row AND a MANUAL row. Rows arrive day-DESC inside each
  // nutrient, so the first DAY seen per code is the latest; a second row
  // for that same day (the other source) adds to the running total instead
  // of opening a new "day".
  //
  // v1.30 (DATAINT M3) — `daysWithData` used to increment on every row
  // whose `day` differed from the PINNED `latestDay` field, so a second
  // source's row on an already-counted OLDER day (e.g. water logged via
  // both APPLE_HEALTH and MANUAL on the same non-latest day) opened a
  // second "day" for that same calendar date. `daysSeen` is a per-nutrient
  // set of distinct day keys — every row adds to it, so a repeated day
  // (any number of source rows) is counted exactly once.
  const byCode = new Map<
    string,
    {
      unit: string;
      latestDay: string;
      latestAmount: number;
      daysSeen: Set<string>;
    }
  >();
  for (const row of rows) {
    const existing = byCode.get(row.nutrient);
    if (!existing) {
      byCode.set(row.nutrient, {
        unit: row.unit,
        latestDay: row.day,
        latestAmount: row.amount,
        daysSeen: new Set([row.day]),
      });
      continue;
    }
    existing.daysSeen.add(row.day);
    if (row.day === existing.latestDay) {
      existing.latestAmount += row.amount;
    }
  }

  // Catalog order; a stored code that ever fell out of the catalog is
  // dropped from the card rather than crashing the label lookup.
  const nutrients = NUTRIENT_CODES.filter(
    (code) => isNutrientCode(code) && byCode.has(code),
  ).map((code) => {
    const summary = byCode.get(code)!;
    return {
      nutrient: code,
      unit: summary.unit,
      latestDay: summary.latestDay,
      latestAmount: summary.latestAmount,
      daysWithData: summary.daysSeen.size,
    };
  });

  // The account holder's only signal that a sync ever arrived is this
  // lookup — the read path stays honest instead of a bare "no data yet"
  // when a batch actually landed and every entry was rejected. Gated on
  // the zero-rows path ONLY: an AuditLog read must never run on the happy
  // path just to serve a read endpoint. COUPLING: this depends on the row
  // still existing — `cleanupOldAuditLogs` (`src/lib/jobs/audit-log-cleanup.ts`)
  // prunes AuditLog nightly past `AUDIT_LOG_RETENTION_DAYS` (365 days by
  // default), so a dormant account whose last failed attempt ages past
  // that window silently loses the explanation and falls back to the
  // plain empty state — anyone changing that retention job should know a
  // user-facing message depends on it.
  let lastAttempt: { at: string; topReason: string } | null = null;
  if (nutrients.length === 0) {
    // Fail soft, deliberately. This lookup exists only to explain an empty
    // page; it is not the page. If it throws — a ledger read that errors, a
    // shape nobody expected — the nutrients read must still answer, with the
    // plain empty state rather than a 500. An explanation that can take down
    // the thing it explains is worse than no explanation.
    try {
      const lastIngest = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: "nutrient.batch.ingest" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, details: true },
      });
      const details = parseLastIngestDetails(lastIngest?.details ?? null);
      // Only surface a reason when the last attempt landed NOTHING: a
      // succeeded attempt whose day just falls outside this window is a
      // different, unrelated situation — showing a failure notice over it
      // would be the very false claim this feature exists to prevent.
      if (details && details.inserted === 0 && details.updated === 0) {
        const topReason = pickTopSkipReason(details.skippedByReason);
        if (topReason) {
          lastAttempt = { at: lastIngest!.createdAt.toISOString(), topReason };
        }
      }
    } catch (err) {
      // Recorded, never rendered: the operator sees it, the person sees the
      // ordinary empty state.
      annotate({
        action: { name: "nutrient.intake.last_attempt_lookup_failed" },
        meta: { reason: err instanceof Error ? err.name : "unknown" },
      });
    }
  }

  annotate({
    action: { name: "nutrient.intake.read" },
    meta: {
      window_days: days,
      nutrient_count: nutrients.length,
      row_count: rows.length,
    },
  });

  return apiSuccess({ windowDays: days, nutrients, lastAttempt });
});
