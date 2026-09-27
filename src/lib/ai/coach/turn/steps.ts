/**
 * Live steps: one `CoachStep` per tool call, emitted as `step` frames while
 * the turn runs and persisted on `metricSource.steps`.
 *
 * A step carries a catalog label key, the server-rendered label, the domain,
 * the window and a server-counted number. Never free text, an analyte name
 * or a health value: every field is either a closed enum member checked
 * here, a catalog string rendered from those enums, or a non-negative
 * integer the server counted. Nothing the model wrote and nothing the
 * record holds as text can reach it, because nothing is copied through
 * without passing one of those checks.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { AiToolCall } from "@/lib/ai/types";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachResultGranularity,
  type CoachResultPeriod,
  type CoachScopeWindow,
  type CoachStep,
  type CoachStepDomain,
  type CoachStepReason,
  type CoachStepStatus,
} from "@/lib/ai/coach/types";
import {
  COACH_STEP_LABEL_KEYS,
  coachDomainLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";
import {
  isCoachToolName,
  type CoachToolName,
} from "@/lib/ai/coach/tools/definitions";

/** At most this many steps per turn; later calls run but show no step. */
export const MAX_TURN_STEPS = 12;

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);
const WINDOWS: ReadonlySet<string> = new Set(coachScopeWindowSchema.options);
const PERIODS: ReadonlySet<string> = new Set<CoachResultPeriod>([
  "current",
  "previous",
  "yearAgo",
]);
const GRANULARITIES: ReadonlySet<string> = new Set<CoachResultGranularity>([
  "day",
  "week",
  "month",
]);

/**
 * The domain each tool reads. `null` means the domain is the validated
 * `metric` argument. A record keyed on the tool name, so a new tool does not
 * compile until it says what it reads.
 */
const TOOL_DOMAIN: Readonly<Record<CoachToolName, CoachStepDomain | null>> = {
  get_metric_series: null,
  get_glucose_panel: "glucose",
  get_sleep: "sleep",
  get_medication_compliance: "compliance",
  get_labs: "labs",
  get_illness_recovery: "illness",
  get_workouts: "workouts",
  get_cycle: "cycle",
  get_correlations: "correlations",
};

/**
 * The window a tool reads when the call names none. `"fallback"` is the
 * conversation's window (the executor's default); `null` is a read with no
 * window at all. Labs read a fixed trailing year whatever the conversation
 * says, so their step says that year rather than the conversation's window.
 */
const TOOL_WINDOW: Readonly<
  Record<CoachToolName, CoachScopeWindow | "fallback" | null>
> = {
  get_metric_series: "fallback",
  get_glucose_panel: "fallback",
  get_sleep: "fallback",
  get_medication_compliance: "fallback",
  get_labs: "lastYear",
  get_illness_recovery: "fallback",
  get_workouts: "fallback",
  get_cycle: null,
  get_correlations: null,
};

/**
 * A miss reason from the executor, mapped onto the step. Anything not listed
 * (a correlation reader's own "no pattern survived" code, a rows-exist-but-
 * no-block verdict) is an empty step with no stated reason: saying "no
 * readings" there would be false.
 */
const MISS: Readonly<
  Record<string, { status: CoachStepStatus; reason?: CoachStepReason }>
> = {
  no_data: { status: "empty", reason: "no_data" },
  analyte_not_found: { status: "empty", reason: "no_data" },
  outside_window: { status: "empty", reason: "outside_window" },
  module_disabled: { status: "empty", reason: "module_disabled" },
  retrieval_failed: { status: "failed", reason: "retrieval_failed" },
  no_data_unconfirmed: { status: "failed", reason: "retrieval_failed" },
  invalid_arguments: { status: "failed", reason: "invalid_arguments" },
  unknown_tool: { status: "failed", reason: "invalid_arguments" },
  unsupported_metric: { status: "failed", reason: "invalid_arguments" },
  use_get_glucose_panel: { status: "failed", reason: "invalid_arguments" },
  use_get_medication_compliance: {
    status: "failed",
    reason: "invalid_arguments",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer, or undefined. Never a float: a count, not a value. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function pick<T extends string>(
  allowed: ReadonlySet<string>,
  value: unknown,
): T | undefined {
  return typeof value === "string" && allowed.has(value)
    ? (value as T)
    : undefined;
}

/**
 * How many readings or rows a present result covered, when the result says
 * so in a field the server counted:
 * - a metric series: the aggregate's coverage count;
 * - workouts: the sessions in the window;
 * - labs: the biomarkers returned (one row each).
 * Anything else carries no count rather than a guess.
 */
function presentCount(tool: CoachToolName, data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  switch (tool) {
    case "get_metric_series": {
      const section = data.section;
      if (!isRecord(section) || !isRecord(section.aggregate)) return undefined;
      const coverage = section.aggregate.coverage;
      return isRecord(coverage) ? asCount(coverage.count) : undefined;
    }
    case "get_workouts":
      return asCount(data.totalInWindow);
    case "get_labs":
      return Array.isArray(data.recent) ? data.recent.length : undefined;
    default:
      return undefined;
  }
}

function render(
  locale: Locale,
  domain: CoachStepDomain,
  window: CoachScopeWindow | undefined,
): { labelKey: string; label: string } {
  const { t } = getServerTranslator(locale);
  const labelKey = window
    ? COACH_STEP_LABEL_KEYS.readWindow
    : COACH_STEP_LABEL_KEYS.read;
  return {
    labelKey,
    label: t(labelKey, {
      domain: t(coachDomainLabelKey(domain)),
      ...(window ? { window: t(coachWindowLabelKey(window)) } : {}),
    }),
  };
}

/**
 * The step for one tool call: `running` when `result` is absent (the call
 * just started), its final status once the result is in. `index` counts
 * calls across the turn from 0; `parsedArgs` are the schema-validated
 * arguments, absent when they did not validate. `fallbackWindow` is the
 * conversation's window, the one a call without a window reads.
 *
 * Null for a call past the cap, for a tool name outside the catalogue, and
 * for a metric call whose metric did not validate: there is nothing true to
 * label those with.
 */
export function toStep(args: {
  call: AiToolCall;
  index: number;
  parsedArgs: Record<string, unknown> | undefined;
  result?: CoachToolResult;
  locale: Locale;
  fallbackWindow?: CoachScopeWindow;
}): CoachStep | null {
  const { call, index, parsedArgs, result, locale } = args;
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_TURN_STEPS) {
    return null;
  }
  if (!isCoachToolName(call.name)) return null;
  const tool = call.name;

  const domain =
    TOOL_DOMAIN[tool] ??
    pick<CoachStepDomain>(SCOPE_SOURCES, parsedArgs?.metric);
  // A metric series call whose arguments did not validate names no domain
  // the executor would read; the executor refuses it and the model is told.
  // There is nothing true to show, so it gets no step.
  if (!domain) return null;

  const windowRule = TOOL_WINDOW[tool];
  const window =
    windowRule === null
      ? undefined
      : windowRule === "fallback"
        ? (pick<CoachScopeWindow>(WINDOWS, parsedArgs?.window) ??
          pick<CoachScopeWindow>(WINDOWS, result?.searchedWindow) ??
          pick<CoachScopeWindow>(WINDOWS, args.fallbackWindow))
        : windowRule;
  const period = pick<CoachResultPeriod>(PERIODS, parsedArgs?.period);
  const granularity = pick<CoachResultGranularity>(
    GRANULARITIES,
    parsedArgs?.granularity,
  );

  const settled = settle(tool, result);
  return {
    id: `s${index + 1}`,
    tool,
    ...render(locale, domain, window),
    domain,
    ...(window ? { window } : {}),
    ...(period ? { period } : {}),
    ...(granularity ? { granularity } : {}),
    status: settled.status,
    ...(settled.count !== undefined ? { count: settled.count } : {}),
    ...(settled.reason ? { reason: settled.reason } : {}),
  };
}

function settle(
  tool: CoachToolName,
  result: CoachToolResult | undefined,
): { status: CoachStepStatus; count?: number; reason?: CoachStepReason } {
  if (!result) return { status: "running" };
  if (result.present) {
    return { status: "done", count: presentCount(tool, result.data) };
  }
  const miss = (typeof result.reason === "string" &&
    Object.hasOwn(MISS, result.reason) &&
    MISS[result.reason]) || { status: "empty" as const };
  // An out-of-window miss knows how much the record holds elsewhere; the
  // count rides the step for the method line, the row shows the reason.
  const count =
    miss.status === "empty" && isRecord(result.available)
      ? asCount(result.available.count)
      : undefined;
  return {
    status: miss.status,
    ...(count !== undefined ? { count } : {}),
    ...(miss.reason ? { reason: miss.reason } : {}),
  };
}

/**
 * The single step a no-tools turn shows: the full snapshot, with the number
 * of metrics it covered. The snapshot is already built when this runs, so
 * the step is settled from the start.
 */
export function snapshotStep(args: {
  metricCount: number;
  locale: Locale;
}): CoachStep | null {
  const { t } = getServerTranslator(args.locale);
  const count = asCount(args.metricCount) ?? 0;
  return {
    id: "s1",
    tool: "snapshot",
    labelKey: COACH_STEP_LABEL_KEYS.snapshot,
    label: t(COACH_STEP_LABEL_KEYS.snapshot),
    domain: "snapshot",
    status: count > 0 ? "done" : "empty",
    count,
    ...(count === 0 ? { reason: "no_data" as const } : {}),
  };
}
