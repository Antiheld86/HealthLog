"use client";

/**
 * v1.39.4 — one table of values a Coach turn read: a captioned table with
 * the first rows shown, the rest behind "Show all", and copy for a
 * spreadsheet or as text.
 *
 * Not built yet: renders nothing.
 */
import type { CoachResultTable as CoachResultTableData } from "@/lib/ai/coach/types";

export interface CoachResultTableProps {
  result: CoachResultTableData;
}

export function CoachResultTable(_props: CoachResultTableProps) {
  return null;
}
