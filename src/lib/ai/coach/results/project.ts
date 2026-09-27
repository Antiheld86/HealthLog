/**
 * Result tables of a turn: the tables its tool calls produced — the metric
 * table tool's own, sleep per night, and the projections of the older
 * tools' results (`projections.ts`: per-sport counts for workouts, the
 * latest reading per analyte for labs, weekly adherence).
 *
 * A table is built by the executor as the call settles, named `r<n>` in the
 * order the calls settled, and rides the call's result beside what the model
 * reads. `projectResults` only collects them, so its input is what the loop
 * settled on THIS turn: a table can never carry another turn's, or another
 * account's, values.
 *
 * Kept light on purpose: the turn imports this module, so it pulls in no
 * reader, no message catalog and no schema.
 */
import type { Locale } from "@/lib/i18n/config";
import type { CoachResultTable } from "@/lib/ai/coach/types";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

import { MAX_RESULTS_PER_TURN, isTurnResultRef } from "./refs";

/** At most this many rows reach a table; a year of days fits. */
export const RESULT_TABLE_MAX_ROWS = 400;

/**
 * The at-rest ceiling for one message's tables, as JSON before encryption.
 * Tables arrive trimmed to 400 rows; a message whose tables still exceed
 * this keeps the leading tables that fit.
 */
export const RESULTS_MAX_BYTES = 128 * 1024;

/**
 * The tables a message keeps: the leading ones whose JSON fits
 * `RESULTS_MAX_BYTES`, whole tables dropped from the end. Applied once,
 * before the turn streams them, so the tables the person sees live are the
 * tables a reload reads back, and the metadata never names a table the
 * ciphertext does not hold.
 */
export function fitResultsToStorage(
  results: readonly CoachResultTable[],
): CoachResultTable[] {
  const kept = results.slice(0, MAX_RESULTS_PER_TURN);
  while (
    kept.length > 0 &&
    new TextEncoder().encode(JSON.stringify(kept)).byteLength >
      RESULTS_MAX_BYTES
  ) {
    kept.pop();
  }
  return kept;
}

/** One tool call of this turn, as the loop settled it. */
export interface SettledToolCall {
  name: string;
  /** Schema-validated arguments; absent when they did not validate. */
  args?: Record<string, unknown>;
  result: CoachToolResult;
}

function refNumber(ref: string): number {
  return Number(ref.slice(1));
}

/**
 * Tables for this turn, in ref order (`r1`..), at most six, each trimmed to
 * `RESULT_TABLE_MAX_ROWS`. `chart` and `chartKind` are left for
 * `deriveChartSpec` to fill.
 */
export function projectResults(args: {
  calls: SettledToolCall[];
  locale: Locale;
}): CoachResultTable[] {
  const seen = new Set<string>();
  const tables: CoachResultTable[] = [];
  for (const call of args.calls) {
    const table = call.result.table;
    if (!table || !isTurnResultRef(table.ref) || seen.has(table.ref)) continue;
    seen.add(table.ref);
    const rows = table.rows.slice(-RESULT_TABLE_MAX_ROWS);
    tables.push({
      ...table,
      rows,
      rowCount: Math.max(table.rowCount, rows.length),
      truncated: table.truncated || rows.length < table.rows.length,
      displayed: false,
      chart: null,
      chartKind: null,
    });
  }
  return tables
    .sort((a, b) => refNumber(a.ref) - refNumber(b.ref))
    .slice(0, MAX_RESULTS_PER_TURN);
}
