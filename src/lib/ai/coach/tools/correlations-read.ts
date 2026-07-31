/**
 * v1.21.0 (C3) — Coach correlations reader.
 *
 * Surfaces the deterministic insight engine's cross-metric intelligence to the
 * Coach via the `get_correlations` tool. Two read-only sources, both already
 * computed elsewhere and reused verbatim here (no new statistics):
 *
 *  - The FDR-controlled, day-D→D+1 lagged all-pairs discovery
 *    (`@/lib/insights/correlation-discovery`). We run the SAME full-matrix scan
 *    the `/api/insights/correlations` route + the per-metric card run, so the
 *    Coach never surfaces a pair the insight pages would not — same Pearson,
 *    same exact p-value, same Benjamini-Hochberg control. We return every
 *    surviving pair (not filtered to one metric) as a descriptive driver row.
 *  - The coincident-deviation flag (`computeCoincidentDeviation`): "two or more
 *    of your vitals are outside their usual band today", with the illness-
 *    explained reframe carried through.
 *
 * Grounding posture mirrors the other tools: a structured `{ present: false }`
 * when too little paired data exists for any pattern to survive (or the read
 * fails), never a throw and never an ambiguous empty list. The driver rows are
 * descriptive — direction + lag + n + the engine's own never-causal
 * interpretation string — so the Coach states the observed linkage without
 * inventing a relationship.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  EARLY_WINDOW_DAYS,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  buildMeasurementDailySeries,
  fetchComplianceSeries,
  fetchLabDraws,
  fetchMeasurementWindowSeries,
  fetchMoodWindowSeries,
  fetchSymptomSeries,
} from "@/lib/insights/correlation-channel-series";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  computeCoincidentDeviation,
  loadBaselineProfile,
  isDerivedOk,
} from "@/lib/insights/derived";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan — mirrors the insight route. */
const WINDOW_DAYS = 180;

/** One discovered driver pair, descriptive — never causal. */
export interface CoachCorrelationDriver {
  behaviour: string;
  outcome: string;
  /** "higher" / "lower" — sign of the next-day association. */
  direction: "higher" | "lower";
  /** Lag in days (always 1 today). */
  lagDays: number;
  /** Paired-day sample count after the lag join. */
  n: number;
  /** Pearson r, rounded for display. */
  r: number;
  /** The engine's conservative, descriptive interpretation. */
  note: string;
}

/** The coincident-deviation summary the Coach can narrate. */
export interface CoachCoincidentFlag {
  /** True when ≥2 vitals are outside their usual band on the latest day. */
  fired: boolean;
  /** The vitals outside their band (possible factors, never a cause). */
  contributing: Array<{ metric: string; direction: "above" | "below" }>;
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /** True when an active illness episode explains the deviations. */
  illnessExplained: boolean;
}

/** One emerging (recent-window) driver — provisional, hedged. */
export interface CoachEmergingDriver extends CoachCorrelationDriver {
  /** Always true here — a recent-window signal on fewer days. */
  provisional: true;
}

/** One labs ↔ outcome association — descriptive, never causal. */
export interface CoachLabCorrelation {
  /** Display analyte name (LAB: prefix stripped). */
  lab: string;
  /** The outcome it tracks with. */
  outcome: string;
  direction: "higher" | "lower";
  /** Paired draws. */
  n: number;
  r: number;
  note: string;
}

export interface CoachCorrelationsResult {
  present: boolean;
  drivers?: CoachCorrelationDriver[];
  /**
   * v1.22 — emerging recent-window drivers NOT yet established by the 180-day
   * scan: early-detection signals the Coach narrates as provisional.
   */
  emerging?: CoachEmergingDriver[];
  /**
   * v1.22 — labs ↔ outcome associations (each draw vs the contemporaneous
   * outcome window-mean), FDR-controlled. Descriptive, never causal.
   */
  labDrivers?: CoachLabCorrelation[];
  coincident?: CoachCoincidentFlag;
  /** How many behaviour×outcome pairs were tested (honest footer). */
  pairsTested?: number;
  /** Trailing-day window the discovery scanned. */
  windowDays?: number;
  reason?: string;
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Natural labels for the non-measurement channel keys (read cleanly in prose). */
const CHANNEL_LABELS: Record<string, string> = {
  [MEDICATION_COMPLIANCE_CHANNEL_KEY]: "medication adherence",
  [SYMPTOM_SEVERITY_CHANNEL_KEY]: "symptom severity",
};

/** Lower-case, space-separated label from a discovery channel key. */
function humanise(key: string): string {
  return CHANNEL_LABELS[key] ?? key.replace(/_/g, " ").toLowerCase();
}

/**
 * Build the Coach correlations payload for a user. Returns `{ present: false }`
 * when no driver survives AND the coincident flag is not informative, when the
 * user has no correlatable data, or on any read/compute failure (best-effort —
 * a correlation hiccup must never break the chat turn).
 */
export async function readCoachCorrelations(
  userId: string,
  /**
   * The reader's locale. Every `note` this returns is a finished sentence that
   * some surface prints verbatim — the metric page's "Coach read" strip does
   * exactly that — so the language has to be decided by whoever knows who is
   * reading. No default: a caller that cannot name a locale is a caller that
   * does not know, and guessing English is how the strip came to answer a
   * German page in English.
   */
  locale: Locale,
): Promise<CoachCorrelationsResult> {
  // v1.30.22 — the `insights` gate lives HERE, at the read, not at each
  // caller. This reader is reached from four places (the Coach
  // `get_correlations` tool, the MCP `get_correlation` rich read, the
  // per-metric "Coach read" strip, and the Coach snapshot); only the REST
  // sibling `/api/insights/correlations` gated, so every other caller
  // defeated both the user's `insights` toggle and the operator availability
  // switch ANDed above it. Gating the reader closes all four at once and
  // means a future caller cannot reintroduce the gap by forgetting.
  //
  // OMIT rather than refuse: this is a per-domain read whose whole contract
  // is already `{ present: false }` for honest absence, and every caller
  // treats a miss as "no pattern to narrate". A throw here would break a
  // Coach turn for a user who simply turned a module off. The distinct
  // `module_disabled` reason keeps it honest — the assistant is told the
  // domain is off, not that no correlation exists.
  //
  // Deliberately OUTSIDE the try/catch: the fail-soft below turns any throw
  // into `{ present: false }`, so a gate placed inside would still close the
  // leak but would silently swallow a real gate failure. Out here, a broken
  // gate is loud.
  if (!(await isModuleEnabled(userId, "insights"))) {
    return { present: false, reason: "module_disabled" };
  }
  try {
    const profile = await loadBaselineProfile(prisma, userId);
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = userRow?.timezone ?? "Europe/Berlin";
    const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

    // The non-MeasurementType channels (MOOD, MEDICATION_COMPLIANCE,
    // SYMPTOM_SEVERITY) are backed by other models — `discoveryMeasurementTypes`
    // drops them so the Postgres `type IN (...)` enum cast only ever sees real
    // enum values; each is sourced separately below, exactly like the route.
    const behaviourTypes = discoveryMeasurementTypes(
      DISCOVERY_BEHAVIOURS,
    ) as MeasurementType[];
    const outcomeTypes = discoveryMeasurementTypes(
      DISCOVERY_OUTCOMES,
    ) as MeasurementType[];

    // v1.30.3 (QA F1) — the fetch + desc/cap/resort discipline (a dense
    // account's cap must fall on the OLDEST rows, never the newest — the
    // emerging-correlations pass below is entirely about the recent window)
    // now lives in `fetchMeasurementWindowSeries` / `fetchMoodWindowSeries`
    // (`correlation-channel-series.ts`), shared with the route, the
    // per-metric card, and the period narrative.
    const [
      { byType, measurementsCapped },
      { moodDaily, moodCapped },
      coincidentDerived,
      priorityJson,
    ] = await Promise.all([
      fetchMeasurementWindowSeries(userId, since, [
        ...behaviourTypes,
        ...outcomeTypes,
      ]),
      fetchMoodWindowSeries(userId, tz, since),
      // Coincident-deviation is its own derived metric — fail-soft to null so a
      // baseline hiccup never sinks the whole correlations read. D2-8: pass the
      // user's tz so the "today" grouping matches the user's calendar day, not
      // UTC's, before the fired flag is narrated as "out of band TODAY".
      computeCoincidentDeviation(userId, profile, { tz }).catch(() => null),
      loadUserSourcePriority(userId),
    ]);
    const seriesPoints = (key: string) =>
      key === "MOOD"
        ? moodDaily
        : buildMeasurementDailySeries(
            key as MeasurementType,
            byType.get(key) ?? [],
            tz,
            priorityJson,
          );

    // The two non-measurement, non-mood channels come from their own sources
    // (the dose-history ledger + the illness day-log), folded in below exactly
    // like the route. Each degrades to an empty series when the user has no
    // data, so the discovery loop drops the channel (it cannot clear the n ≥ 20
    // floor) — it can never surface a fabricated driver.
    const [complianceSeries, symptomSeries, labDraws] = await Promise.all([
      fetchComplianceSeries(userId, tz, since),
      fetchSymptomSeries(userId, tz, since),
      // v1.22 — lab draws for the labs ↔ outcome pass (degrades to absent).
      fetchLabDraws(userId, tz, since),
    ]);

    const series: NamedSeries[] = [];
    for (const key of DISCOVERY_BEHAVIOURS) {
      if (key === MEDICATION_COMPLIANCE_CHANNEL_KEY) {
        series.push(complianceSeries);
      } else if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
        series.push({ ...symptomSeries, role: "behaviour" });
      } else {
        series.push({ key, role: "behaviour", points: seriesPoints(key) });
      }
    }
    for (const key of DISCOVERY_OUTCOMES) {
      if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
        series.push({ ...symptomSeries, role: "outcome" });
      } else {
        series.push({ key, role: "outcome", points: seriesPoints(key) });
      }
    }

    // QA F1 — surfaces when a dense account's window exceeded the read cap,
    // mirroring the route's identical annotation. The cap now falls on the
    // OLDEST rows (desc + take), so a capped read still covers the recent
    // window the emerging-correlations pass below needs.
    annotate({
      action: { name: "coach.correlations.read" },
      meta: {
        measurements_capped: measurementsCapped,
        mood_entries_capped: moodCapped,
      },
    });

    const discovery = discoverCorrelations(series, { locale });
    const drivers: CoachCorrelationDriver[] = discovery.discovered.map((d) => ({
      behaviour: humanise(d.behaviour),
      outcome: humanise(d.outcome),
      direction: d.r >= 0 ? "higher" : "lower",
      lagDays: d.lagDays,
      n: d.n,
      r: Math.round(d.r * 100) / 100,
      note: d.interpretation,
    }));

    // v1.22 — rolling early-detection pass over the trailing window (re-uses
    // the already-built series). Emerging pairs exclude anything the 180-day
    // scan already established, so the Coach never narrates the same pattern as
    // both "established" and "emerging".
    const recentFromDayKey = tzDayKey(
      new Date(Date.now() - EARLY_WINDOW_DAYS * MS_PER_DAY),
      tz,
    );
    const emergingResult = discoverEmergingCorrelations(series, discovery, {
      recentFromDayKey,
      locale,
    });
    const emerging: CoachEmergingDriver[] = emergingResult.emerging.map(
      (d) => ({
        behaviour: humanise(d.behaviour),
        outcome: humanise(d.outcome),
        direction: d.r >= 0 ? "higher" : "lower",
        lagDays: d.lagDays,
        n: d.n,
        r: Math.round(d.r * 100) / 100,
        note: d.interpretation,
        provisional: true,
      }),
    );

    // v1.22 — labs ↔ outcome pass (point-vs-window over sparse draws).
    const labResult = discoverLabOutcomeCorrelations(labDraws, series, {
      locale,
    });
    const labDrivers: CoachLabCorrelation[] = labResult.discovered.map((d) => ({
      lab: d.lab.startsWith("LAB:") ? d.lab.slice("LAB:".length) : d.lab,
      outcome: humanise(d.outcome),
      direction: d.r >= 0 ? "higher" : "lower",
      n: d.n,
      r: Math.round(d.r * 100) / 100,
      note: d.interpretation,
    }));

    const coincident = buildCoincidentFlag(coincidentDerived);

    // Nothing to say: no surviving driver of any kind AND the coincident flag is
    // either insufficient or quiet (not fired). Report a clean miss.
    if (
      drivers.length === 0 &&
      emerging.length === 0 &&
      labDrivers.length === 0 &&
      (!coincident || !coincident.fired)
    ) {
      return { present: false, reason: "no_significant_pattern" };
    }

    return {
      present: true,
      ...(drivers.length > 0 ? { drivers } : {}),
      ...(emerging.length > 0 ? { emerging } : {}),
      ...(labDrivers.length > 0 ? { labDrivers } : {}),
      ...(coincident ? { coincident } : {}),
      pairsTested: discovery.pairsTested,
      windowDays: WINDOW_DAYS,
    };
  } catch {
    return { present: false, reason: "retrieval_failed" };
  }
}

/** Shape the derived coincident-deviation value into the Coach summary. */
function buildCoincidentFlag(
  derived: Awaited<ReturnType<typeof computeCoincidentDeviation>> | null,
): CoachCoincidentFlag | undefined {
  if (!derived || !isDerivedOk(derived)) return undefined;
  const v = derived.value;
  return {
    fired: v.fired,
    contributing: v.contributing.map((c) => ({
      metric: humanise(String(c.type)),
      direction: c.direction === "above" ? "above" : "below",
    })),
    day: v.day,
    illnessExplained: v.illnessExplained,
  };
}
