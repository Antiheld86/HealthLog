/**
 * Live steps: one `CoachStep` per tool call, emitted as `step` frames while
 * the turn runs and persisted on `metricSource.steps`.
 *
 * A step carries a catalog label key, the server-rendered label, the domain,
 * the window and a server-counted number. Never free text, an analyte name
 * or a health value.
 *
 * Not built yet: both functions answer null, so a turn emits no step frame.
 */
import type { Locale } from "@/lib/i18n/config";
import type { AiToolCall } from "@/lib/ai/types";
import type { CoachStep } from "@/lib/ai/coach/types";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

/**
 * The step for one tool call: `running` when `result` is absent (the call
 * just started), its final status once the result is in. `index` counts
 * calls across the turn from 0; `parsedArgs` are the schema-validated
 * arguments, absent when they did not validate.
 */
export function toStep(_args: {
  call: AiToolCall;
  index: number;
  parsedArgs: Record<string, unknown> | undefined;
  result?: CoachToolResult;
  locale: Locale;
}): CoachStep | null {
  return null;
}

/**
 * The single step a no-tools turn shows: the full snapshot, with the number
 * of metrics it covered.
 */
export function snapshotStep(_args: {
  metricCount: number;
  locale: Locale;
}): CoachStep | null {
  return null;
}
