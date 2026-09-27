/**
 * The chart a result table gets, chosen on the server from the table's shape
 * and the metric: a line for level metrics over time, a bar for totals and
 * category counts, a histogram for a distribution, or none (table only)
 * when the table is too short, too long or has no numeric column.
 *
 * Pure. Not built yet: every table stays table-only.
 */
import type { CoachChartSpec, CoachResultTable } from "@/lib/ai/coach/types";

export function deriveChartSpec(
  _table: Omit<CoachResultTable, "chart" | "chartKind">,
): CoachChartSpec | null {
  return null;
}
