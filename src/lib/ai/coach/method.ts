/**
 * The method line under an answer: which sources, windows, counts and
 * aggregation it rests on, rendered on the server in the request locale.
 * "Blood pressure, last 90 days: 142 readings, weekly averages · Sleep, last
 * 30 days: no readings in this window".
 *
 * Built from what the server recorded about the turn (the steps and the
 * result tables), never from model text. It carries catalog strings and
 * server-counted integers only, so a health value cannot reach it: a step's
 * `label` is never read, and a count is the number of readings, not a
 * reading. A domain the turn found nothing for says so; absence is part of
 * the method, not a gap in it.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type {
  CoachMethod,
  CoachMethodEntry,
  CoachResultMeta,
  CoachStep,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import {
  COACH_METHOD_ABSENT_KEYS,
  COACH_METHOD_AGGREGATION_KEYS,
  COACH_METHOD_KEYS,
  coachDomainLabelKey,
  coachPeriodLabelKey,
  coachWindowLabelKey,
  methodAveragesKey,
  methodReadingsKey,
  methodTotalsKey,
} from "@/lib/ai/coach/dialog-keys";

/** More than this and the line stops being a line. */
export const METHOD_MAX_ENTRIES = 6;

type Aggregation = NonNullable<CoachMethodEntry["aggregation"]>;
type Absent = NonNullable<CoachMethodEntry["absent"]>;

/**
 * Metrics whose buckets are totals (a week of steps is summed, not
 * averaged). Every other time series is a level, and its buckets are means.
 */
const TOTAL_METRICS: ReadonlySet<CoachStepDomain> = new Set<CoachStepDomain>([
  "steps",
  "active_energy",
  "flights",
  "distance",
  "daylight",
]);

const ABSENT_REASONS: ReadonlySet<string> = new Set<Absent>([
  "no_data",
  "outside_window",
  "module_disabled",
]);

function aggregationFor(result: CoachResultMeta): Aggregation | undefined {
  switch (result.shape) {
    case "categoryCounts":
    case "distribution":
      return "count";
    case "single":
      return "latest";
    case "timeSeries": {
      const domain = result.source.domain;
      if (domain === "compliance") return "rate";
      // One night per day: a day table of sleep is the nights themselves.
      if (domain === "sleep" && result.source.granularity === "day") {
        return undefined;
      }
      return TOTAL_METRICS.has(domain) ? "sum" : "mean";
    }
  }
}

function entryKey(e: CoachMethodEntry): string {
  return [e.domain, e.window ?? "", e.period ?? "", e.granularity ?? ""].join(
    "|",
  );
}

/** The entries, in the order the turn read them, one per read. */
export function methodEntries(
  steps: readonly CoachStep[],
  results: readonly CoachResultMeta[],
): CoachMethodEntry[] {
  const byRef = new Map(results.map((r) => [r.ref, r]));
  const usedRefs = new Set<string>();
  const entries = new Map<string, CoachMethodEntry>();

  const add = (entry: CoachMethodEntry) => {
    const key = entryKey(entry);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, entry);
      return;
    }
    // The same read twice (a retry, a show_result of this turn's table):
    // one entry, the fullest one. A found read outranks an absent one.
    if (existing.absent && !entry.absent) {
      entries.set(key, entry);
      return;
    }
    if (!entry.absent) {
      entries.set(key, {
        ...existing,
        ...(entry.count !== undefined &&
        (existing.count === undefined || entry.count > existing.count)
          ? { count: entry.count }
          : {}),
        ...(existing.aggregation === undefined && entry.aggregation
          ? { aggregation: entry.aggregation }
          : {}),
      });
    }
  };

  for (const step of steps) {
    if (!step.domain || step.domain === "snapshot") continue;
    const result = step.resultRef ? byRef.get(step.resultRef) : undefined;
    if (result) usedRefs.add(result.ref);
    const window = step.window ?? result?.source.window;
    const period = step.period ?? result?.source.period;
    const granularity = step.granularity ?? result?.source.granularity;
    const base: CoachMethodEntry = {
      domain: step.domain,
      ...(window ? { window } : {}),
      ...(period ? { period } : {}),
      ...(granularity ? { granularity } : {}),
    };
    if (step.status === "empty") {
      if (step.reason && ABSENT_REASONS.has(step.reason)) {
        add({ ...base, absent: step.reason as Absent });
      }
      continue;
    }
    // A running step never finished; a failed one was not read, which is
    // not the same as nothing being there. The step list says which.
    if (step.status !== "done") continue;
    const aggregation = result ? aggregationFor(result) : undefined;
    add({
      ...base,
      ...(typeof step.count === "number" && step.count >= 0
        ? { count: Math.floor(step.count) }
        : {}),
      ...(aggregation ? { aggregation } : {}),
    });
  }

  // A table no step accounts for still says how it was built.
  for (const result of results) {
    if (usedRefs.has(result.ref)) continue;
    const aggregation = aggregationFor(result);
    add({
      domain: result.source.domain,
      window: result.source.window,
      period: result.source.period,
      ...(result.source.granularity
        ? { granularity: result.source.granularity }
        : {}),
      ...(aggregation ? { aggregation } : {}),
    });
  }

  return [...entries.values()];
}

function renderEntry(
  entry: CoachMethodEntry,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale,
): string | null {
  const details: string[] = [];
  if (entry.absent) {
    details.push(t(COACH_METHOD_ABSENT_KEYS[entry.absent]));
  } else {
    if (entry.count !== undefined) {
      details.push(
        t(methodReadingsKey(entry.count, locale), { count: entry.count }),
      );
    }
    if (entry.aggregation === "mean" && entry.granularity) {
      details.push(t(methodAveragesKey(entry.granularity)));
    } else if (entry.aggregation === "sum" && entry.granularity) {
      details.push(t(methodTotalsKey(entry.granularity)));
    } else if (entry.aggregation) {
      details.push(t(COACH_METHOD_AGGREGATION_KEYS[entry.aggregation]));
    }
  }
  // Nothing to say about how it was worked out: the step list already
  // names the source.
  if (details.length === 0) return null;

  const domain = t(coachDomainLabelKey(entry.domain));
  const when = [
    ...(entry.window ? [t(coachWindowLabelKey(entry.window))] : []),
    ...(entry.period && entry.period !== "current"
      ? [t(coachPeriodLabelKey(entry.period))]
      : []),
  ].join(", ");
  const detail = details.join(", ");
  return when
    ? t(COACH_METHOD_KEYS.entry, { domain, window: when, detail })
    : t(COACH_METHOD_KEYS.entryNoWindow, { domain, detail });
}

export function buildMethod(args: {
  steps: CoachStep[];
  results: CoachResultMeta[];
  locale: Locale;
}): CoachMethod | null {
  const { locale } = args;
  const { t } = getServerTranslator(locale);
  const rendered: Array<{ entry: CoachMethodEntry; text: string }> = [];
  for (const entry of methodEntries(args.steps, args.results)) {
    const text = renderEntry(entry, t, locale);
    if (text) rendered.push({ entry, text });
    if (rendered.length === METHOD_MAX_ENTRIES) break;
  }
  if (rendered.length === 0) return null;
  return {
    entries: rendered.map((r) => r.entry),
    text: rendered.map((r) => r.text).join(" · "),
  };
}
