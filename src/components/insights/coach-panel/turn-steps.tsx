"use client";

/**
 * v1.39.4 — what the Coach read on a turn: a compact list of steps under
 * the assistant avatar, live while the turn runs (from the `step` frames)
 * and restored from `metricSource.steps` on reload.
 *
 * Not built yet: renders nothing.
 */
import type { CoachStep } from "@/lib/ai/coach/types";

export interface CoachTurnStepsProps {
  steps: CoachStep[];
  /** True while the turn is still running. */
  active: boolean;
}

export function CoachTurnSteps(_props: CoachTurnStepsProps) {
  return null;
}
