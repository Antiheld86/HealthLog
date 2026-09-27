/**
 * Project this turn's tool results into result tables: per-sport counts for
 * workouts, the latest reading per analyte for labs, per-night sleep, the
 * compliance timeline, and the metric table tool's own rows.
 *
 * Input is only what the loop settled on THIS turn, so a table can never
 * carry another turn's, or another account's, values.
 *
 * Not built yet: answers no tables.
 */
import type { Locale } from "@/lib/i18n/config";
import type { CoachResultTable } from "@/lib/ai/coach/types";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

/** One tool call of this turn, as the loop settled it. */
export interface SettledToolCall {
  name: string;
  /** Schema-validated arguments; absent when they did not validate. */
  args?: Record<string, unknown>;
  result: CoachToolResult;
}

/**
 * Tables for this turn, refs `r1`.. in call order. `chart` and `chartKind`
 * are left for `deriveChartSpec` to fill.
 */
export function projectResults(_args: {
  calls: SettledToolCall[];
  locale: Locale;
}): CoachResultTable[] {
  return [];
}
