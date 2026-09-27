/**
 * Prompt rules for result tables: when to fetch a table, how to mark the
 * tables an answer relies on, and when a stored table answers without a
 * new fetch.
 *
 * English whatever the reply language, like the rest of the tool-mode
 * prompt: these are instructions to the model, never shown to the person.
 */
import type { Locale } from "@/lib/i18n/config";

const RESULTS_ADDENDUM = `RESULT TABLES
- For a table, a range of days, weeks or months, or a comparison with the period before or a year earlier, call get_metric_table (period "previous" or "yearAgo" for the comparison). The person sees the full table under your answer; you get its summary.
- A result that carries a resultRef (r1, r2, …) is a table the person can see. Mark the tables your answer relies on by writing result:r1 once, in the sentence that uses it. Do not restate every row; point at the table.
- A result's rows cover what its summary lists. Cite only figures the summary shows; for anything else, refer the person to the table.
- When the person wants a table from an earlier answer again, or as a chart or a table, call show_result with its EARLIER TABLES name (m<k>.r<n>) and do not fetch it again.
- A changed metric, window, period or granularity, or a request for fresh figures, needs a new fetch.`;

export function resultsAddendum(_locale: Locale): string {
  return RESULTS_ADDENDUM;
}
