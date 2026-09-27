"use client";

/**
 * v1.39.4 — the tables under an assistant reply. A live turn hands its
 * tables in from the `result` frames; a persisted message lists only their
 * metadata, and the values are fetched when the message scrolls into view
 * (`useCoachMessageResults`). A withheld table is skipped here; the notice
 * for it belongs to the table view.
 */
import { useCoachMessageResults } from "@/hooks/use-coach-message-results";
import type {
  CoachResultMeta,
  CoachResultTable as CoachResultTableData,
} from "@/lib/ai/coach/types";

import { CoachResultTable } from "./result-table";

export interface CoachResultsProps {
  conversationId: string | null;
  /** The persisted message, once it has an id. */
  messageId: string | null;
  /** `metricSource.results` of the message. */
  metas: CoachResultMeta[];
  /** The tables a live turn streamed; absent on a persisted message. */
  live?: CoachResultTableData[];
}

export function CoachResults({
  conversationId,
  messageId,
  metas,
  live,
}: CoachResultsProps) {
  const hasLive = (live?.length ?? 0) > 0;
  const { ref, results } = useCoachMessageResults({
    conversationId,
    messageId,
    enabled: !hasLive && metas.length > 0,
  });
  if (!hasLive && metas.length === 0) return null;
  const tables: CoachResultTableData[] = hasLive
    ? (live ?? [])
    : (results ?? []).filter(
        (entry): entry is CoachResultTableData => !("withheld" in entry),
      );
  return (
    <div ref={ref} data-slot="coach-results" className="flex flex-col gap-3">
      {tables.map((table) => (
        <CoachResultTable key={table.ref} result={table} />
      ))}
    </div>
  );
}
