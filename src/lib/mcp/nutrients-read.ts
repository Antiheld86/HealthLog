/**
 * `get_nutrients` — MCP read for the `NutrientIntakeDay` pipeline (v1.30
 * coverage review G1).
 *
 * Thin façade over the SAME two reads `GET /api/nutrients` (presence
 * overview) and `GET /api/nutrients/daily` (per-day summed series + the
 * resolved EFSA reference) run: the same tz-anchored day-key math
 * (`userDayKey` / `shiftDateKey` against the caller's own local "today"),
 * the same sum-across-sources fold (a day can carry an APPLE_HEALTH row AND
 * a MANUAL row since migration 0249), and the same sex-aware
 * `resolveNutrientReference` — omit, never guess, when the profile has no
 * sex on file. No new analytics.
 *
 * Gated on the opt-in `nutrients` module (`isModuleEnabled`) exactly like
 * both backing routes: the module ships dark, so an assistant against an
 * account that never turned it on gets an honest
 * `{ present: false, reason: "module_disabled" }` rather than reading as
 * "nothing logged". `userId` is the session-narrowed id the caller passes;
 * never a tool argument.
 */
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { binaryReferenceSex, type BinaryReferenceSex } from "@/lib/profile/sex";
import {
  NUTRIENT_CATALOG,
  NUTRIENT_CODES,
  isNutrientCode,
  resolveNutrientReference,
  type NutrientCode,
  type ResolvedNutrientReference,
} from "@/lib/nutrients/catalog";
import { defaultLocale } from "@/lib/i18n/config";
import {
  buildLocalisedLabelIndex,
  foldLabel,
  labelIn,
} from "@/lib/i18n/localised-label-index";
import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

/** The i18n key the app already labels a nutrient with, in every bundle. */
function nutrientLabelKey(code: NutrientCode): string {
  return `nutrients.names.${code}`;
}

/**
 * English display labels for the closed nutrient catalog, READ OUT of
 * `messages/en.json`'s `nutrients.names.*` bundle rather than transcribed
 * here. MCP text stays protocol-level English on purpose (see
 * `MCP_SERVER_INSTRUCTIONS`'s own docblock); what changed is only where the
 * English wording comes from, so it can no longer drift from the settings
 * card the user reads.
 *
 * A missing key throws at module load — the same "fail loudly rather than
 * silently under-serve" posture `MCP_METRIC_STATUS_DISCOVERY` takes in
 * `rich-reads.ts`, and the i18n bundle guards would have caught it first.
 */
export const NUTRIENT_LABELS: Readonly<Record<NutrientCode, string>> =
  Object.freeze(
    Object.fromEntries(
      NUTRIENT_CODES.map((code) => {
        const label = labelIn(defaultLocale, nutrientLabelKey(code));
        if (label === null) {
          throw new Error(
            `message bundle is missing ${nutrientLabelKey(code)}`,
          );
        }
        return [code, label];
      }),
    ) as Record<NutrientCode, string>,
  );

/**
 * Folded nutrient name → code, across EVERY shipped locale.
 *
 * `Fer` and `Żelazo` used to reach `unknown_nutrient` while the app rendered
 * exactly those words on its own settings card, because the resolver compared
 * against a hand-typed English copy of the bundle. The index is derived from
 * `locales`, so a seventh language starts resolving the moment its bundle
 * lands, with no edit here.
 */
const NUTRIENT_NAME_INDEX = buildLocalisedLabelIndex<NutrientCode>(
  NUTRIENT_CODES.map((code) => ({
    id: code,
    messageKey: nutrientLabelKey(code),
    value: code,
  })),
);

/** Overview mode (no `nutrient` arg) mirrors `GET /api/nutrients`'s bounds. */
const OVERVIEW_DEFAULT_DAYS = 14;
const OVERVIEW_MAX_DAYS = 365;
/** Per-nutrient mode mirrors `GET /api/nutrients/daily`'s bounds. */
const DAILY_DEFAULT_DAYS = 30;
const DAILY_MAX_DAYS = 90;

export interface NutrientsOverviewResult {
  present: boolean;
  reason?: string;
  windowDays?: number;
  nutrients?: Array<{
    nutrient: NutrientCode;
    label: string;
    unit: string;
    latestDay: string;
    latestAmount: number;
    daysWithData: number;
  }>;
}

export interface NutrientsDailyResult {
  present: boolean;
  reason?: string;
  nutrient?: NutrientCode;
  label?: string;
  unit?: string;
  windowDays?: number;
  days?: Array<{ day: string; amount: number }>;
  reference?: ResolvedNutrientReference | null;
}

/**
 * Resolve a free-text nutrient name to a catalog code, or `null`. Forgiving
 * for an NL assistant (the exact code, or the display name in ANY shipped
 * language, with case, accents and separators folded) but closed to the
 * 26-code catalog — an unresolved name reports
 * `{ present: false, reason: "unknown_nutrient" }` rather than inventing a
 * series.
 *
 * `unknown_nutrient` therefore keeps meaning "we could not place this word",
 * distinct from a resolved code that then answers
 * `{ present: false, reason: "no_data" }` — "placed, and honestly not
 * recorded". Widening what resolves moves words from the first answer to the
 * second; it never turns absence into data.
 */
export function resolveNutrientCode(input: string): NutrientCode | null {
  const raw = input.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (isNutrientCode(key)) return key;
  return NUTRIENT_NAME_INDEX.index.get(foldLabel(raw)) ?? null;
}

/** Presence overview across every logged code — mirrors `GET /api/nutrients`. */
async function readOverview(
  userId: string,
  userTz: string,
  days: number,
): Promise<NutrientsOverviewResult> {
  const todayKey = userDayKey(new Date(), userTz);
  const since = shiftDateKey(todayKey, -(days - 1));

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId, day: { gte: since } },
    orderBy: [{ nutrient: "asc" }, { day: "desc" }],
    select: { nutrient: true, unit: true, day: true, amount: true },
  });

  // v1.29 — `source` joined the PK (migration 0249): a day can carry an
  // APPLE_HEALTH row AND a MANUAL row. Rows arrive day-DESC inside each
  // nutrient, so the first day seen per code is the latest; a second row for
  // that same day (the other source) adds to the running total. `daysSeen` is
  // a per-nutrient SET of distinct day keys so a repeated day (any number of
  // source rows) counts exactly once — the same fold `GET /api/nutrients`
  // applies (see that route's docblock).
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

  const nutrients = NUTRIENT_CODES.filter(
    (code) => isNutrientCode(code) && byCode.has(code),
  ).map((code) => {
    const summary = byCode.get(code)!;
    return {
      nutrient: code,
      label: NUTRIENT_LABELS[code],
      unit: summary.unit,
      latestDay: summary.latestDay,
      latestAmount: summary.latestAmount,
      daysWithData: summary.daysSeen.size,
    };
  });

  return {
    present: nutrients.length > 0,
    ...(nutrients.length === 0 ? { reason: "no_data" } : {}),
    windowDays: days,
    nutrients,
  };
}

/** One nutrient's per-day series + reference — mirrors `GET /api/nutrients/daily`. */
async function readDaily(
  userId: string,
  userTz: string,
  sex: BinaryReferenceSex | null,
  nutrient: NutrientCode,
  days: number,
): Promise<NutrientsDailyResult> {
  const definition = NUTRIENT_CATALOG[nutrient];
  const todayKey = userDayKey(new Date(), userTz);
  const sinceKey = shiftDateKey(todayKey, -(days - 1));

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId, nutrient, day: { gte: sinceKey } },
    select: { day: true, amount: true },
  });

  // Sum across sources within a day BEFORE bucketing — the same fold `GET
  // /api/nutrients/daily` applies.
  const sumByDay = new Map<string, number>();
  for (const row of rows) {
    sumByDay.set(row.day, (sumByDay.get(row.day) ?? 0) + row.amount);
  }

  const daySeries: Array<{ day: string; amount: number }> = [];
  for (let i = 0; i < days; i++) {
    const key = shiftDateKey(sinceKey, i);
    daySeries.push({ day: key, amount: sumByDay.get(key) ?? 0 });
  }

  const reference = resolveNutrientReference(nutrient, sex);

  return {
    present: rows.length > 0,
    ...(rows.length === 0 ? { reason: "no_data" } : {}),
    nutrient,
    label: NUTRIENT_LABELS[nutrient],
    unit: definition.unit,
    windowDays: days,
    days: daySeries,
    reference,
  };
}

function clampDays(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

/**
 * `get_nutrients` entry point. No `nutrient` → the presence overview
 * (latest day / latest total / days-with-data per logged code). A named
 * `nutrient` → that code's per-day summed series over a trailing window plus
 * its resolved EFSA reference. `{ present: false, reason: "module_disabled" }`
 * when the opt-in `nutrients` module is off — checked before any other read,
 * mirroring both backing routes.
 */
export async function getNutrients(
  userId: string,
  args: { nutrient?: string; days?: number },
): Promise<NutrientsOverviewResult | NutrientsDailyResult> {
  const enabled = await isModuleEnabled(userId, "nutrients");
  if (!enabled) {
    return { present: false, reason: "module_disabled" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, gender: true },
  });
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  const sex = binaryReferenceSex(user?.gender);

  if (!args.nutrient) {
    const days = clampDays(args.days, OVERVIEW_DEFAULT_DAYS, OVERVIEW_MAX_DAYS);
    return readOverview(userId, userTz, days);
  }

  const code = resolveNutrientCode(args.nutrient);
  if (!code) {
    return { present: false, reason: "unknown_nutrient" };
  }
  const days = clampDays(args.days, DAILY_DEFAULT_DAYS, DAILY_MAX_DAYS);
  return readDaily(userId, userTz, sex, code, days);
}
