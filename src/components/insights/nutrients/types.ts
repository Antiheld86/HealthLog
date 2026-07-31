/**
 * v1.29 — shared client-side DTOs for the `/insights/nutrients` cards.
 * Mirror the Zod response schemas in `src/lib/validations/nutrients.ts`
 * (`nutrientDailySeriesSchema` / `nutrientOverviewSchema`) — kept as
 * plain interfaces here so the client components stay decoupled from
 * the server-only Zod module graph.
 */

export interface ResolvedNutrientReferenceDto {
  kind: "PRI" | "AI" | "safeLevel";
  direction: "target" | "upperGuidance";
  value: number;
  source: string;
}

export interface NutrientDailySeries {
  nutrient: string;
  unit: string;
  windowDays: number;
  days: Array<{ day: string; amount: number }>;
  reference: ResolvedNutrientReferenceDto | null;
}

export interface NutrientOverviewRow {
  nutrient: string;
  unit: string;
  latestDay: string;
  latestAmount: number;
  daysWithData: number;
}

/**
 * Non-null only when `nutrients` is empty AND the most recent
 * `nutrient.batch.ingest` audit row shows a call that landed nothing —
 * `topReason` is the most common of the closed skip-reason codes
 * (`unit_mismatch` | `value_out_of_range` | `day_invalid` |
 * `upsert_failed`) from that call.
 */
export interface NutrientLastIngestAttempt {
  at: string;
  topReason: string;
}

export interface NutrientIntakeOverview {
  windowDays: number;
  nutrients: NutrientOverviewRow[];
  lastAttempt: NutrientLastIngestAttempt | null;
}
