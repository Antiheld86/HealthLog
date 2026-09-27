"use client";

/**
 * v1.39.4 — how an answer was worked out, as one muted line inside the
 * evidence disclosure: sources, windows, counts and aggregation, rendered
 * on the server. Never a health value.
 *
 * Not built yet: renders nothing.
 */
import type { CoachMethod } from "@/lib/ai/coach/types";

export interface CoachMethodLineProps {
  method: CoachMethod | null;
}

export function CoachMethodLine(_props: CoachMethodLineProps) {
  return null;
}
