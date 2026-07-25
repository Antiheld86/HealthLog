import type { Page } from "@playwright/test";

import {
  SECTION_MOBILITY,
  SECTION_VITALS,
} from "@/components/insights/derived/use-dashboard-derived";

/**
 * A POPULATED Insights overview fixture.
 *
 * The mobile-overflow guard exists to prove that a page carrying real content
 * does not scroll sideways. Against the shared e2e account — which owns no
 * measurements — `/insights` resolves to its empty state, and an empty page
 * trivially fits any viewport. Every section below therefore gets a body:
 * populated wellness scores, a full vitals grid, and the "signals of the day"
 * card whose heading carries the long plain-language provenance caption.
 *
 * The strings are deliberately long. Prose in a heading's trailing `action`
 * slot is exactly what widened the page in the first place, and a fixture with
 * short labels would not reproduce it.
 */

const NOW = "2026-01-15T08:30:00.000Z";

function provenance(inputs: string[]) {
  return {
    inputs,
    source: "DAY" as const,
    windowDays: 30,
    computedAt: NOW,
  };
}

function coverage() {
  return {
    requiredInputs: 4,
    presentInputs: 4,
    historyDays: 90,
    missing: [] as string[],
  };
}

function confidence() {
  return { score: 88, band: "high" as const };
}

function deviation(
  type: string,
  value: number,
  low: number,
  high: number,
  direction: "above" | "below" | "in",
) {
  return {
    type,
    value,
    center: (low + high) / 2,
    low,
    high,
    outside: direction !== "in",
    direction,
  };
}

/**
 * The "signals of the day" payload in its `fired` state — the branch that
 * renders `SectionHeading action={<CoincidentProvenance/>}`, i.e. a full
 * sentence pinned into the heading row.
 */
const COINCIDENT_FIRED = {
  metric: "COINCIDENT_DEVIATION",
  status: "ok" as const,
  value: {
    fired: true,
    day: "2026-01-15",
    illnessExplained: false,
    vitals: [
      deviation("RESTING_HEART_RATE", 71, 52, 62, "above"),
      deviation("HEART_RATE_VARIABILITY", 38, 45, 78, "below"),
      deviation("RESPIRATORY_RATE", 17.4, 12.5, 16.2, "above"),
      deviation("OXYGEN_SATURATION", 97, 96, 99, "in"),
      deviation("BODY_TEMPERATURE", 36.9, 36.2, 37.1, "in"),
    ],
    contributing: [
      deviation("RESTING_HEART_RATE", 71, 52, 62, "above"),
      deviation("HEART_RATE_VARIABILITY", 38, 45, 78, "below"),
      deviation("RESPIRATORY_RATE", 17.4, 12.5, 16.2, "above"),
    ],
  },
  coverage: coverage(),
  confidence: confidence(),
  provenance: provenance([
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "RESPIRATORY_RATE",
  ]),
  reason: null,
};

/** A deterministic sparkline series around `center`. */
function series(center: number, spread: number): number[] {
  return Array.from({ length: 30 }, (_, i) =>
    Number((center + Math.sin(i / 2.5) * spread).toFixed(2)),
  );
}

/**
 * A populated `WellnessScoreValue` entry — the exact wire shape the three
 * persisted score types share (`RECOVERY_SCORE` / `STRESS_SCORE` /
 * `STRAIN_SCORE`).
 */
function wellnessScore(
  metric: string,
  score: number,
  band: "green" | "yellow" | "red",
) {
  return {
    metric,
    status: "ok" as const,
    value: {
      score,
      band,
      trendDelta: 3.4,
      daysInWindow: 28,
      asOf: NOW,
      series: series(score, 6),
    },
    coverage: coverage(),
    confidence: confidence(),
    provenance: provenance(["SLEEP_DURATION", "RESTING_HEART_RATE"]),
    reason: null,
    assessment: null,
  };
}

/** A populated `VitalsBaselineValue` tile — exact wire shape. */
function vitalsBaseline(type: string, center: number, spread: number) {
  return {
    metric: "VITALS_BASELINE",
    status: "ok" as const,
    value: {
      type,
      center,
      low: Number((center - spread).toFixed(2)),
      high: Number((center + spread).toFixed(2)),
      spread,
      sampleDays: 30,
      k: 2,
      series: series(center, spread / 2),
    },
    coverage: coverage(),
    confidence: confidence(),
    provenance: provenance([type]),
    reason: null,
  };
}

/**
 * The honest "not enough history" arm. Metrics whose value shapes this fixture
 * does not reproduce exactly are served as `insufficient` rather than as an
 * invented payload — that is a real state those tiles handle (they un-mount),
 * and a wrong-shaped `ok` payload would throw in the tile instead of testing
 * anything.
 */
function insufficient(metric: string) {
  return {
    metric,
    status: "insufficient" as const,
    value: null,
    coverage: {
      requiredInputs: 4,
      presentInputs: 1,
      historyDays: 3,
      missing: ["SLEEP_DURATION"],
    },
    confidence: null,
    provenance: provenance([]),
    reason: "not_enough_history",
  };
}

/** Center + spread per vital, in each metric's own units. */
const VITAL_BANDS: Record<string, [number, number]> = {
  RESTING_HEART_RATE: [57, 5],
  RESPIRATORY_RATE: [14.1, 1.8],
  OXYGEN_SATURATION: [97, 1.5],
  BODY_TEMPERATURE: [36.6, 0.45],
  BLOOD_GLUCOSE: [92, 13],
  WEIGHT: [79.4, 3],
};

function buildBatchMetrics(): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    RECOVERY_SCORE: wellnessScore("RECOVERY_SCORE", 66, "yellow"),
    STRESS_SCORE: wellnessScore("STRESS_SCORE", 41, "green"),
    STRAIN_SCORE: wellnessScore("STRAIN_SCORE", 72, "yellow"),
    READINESS: insufficient("READINESS"),
    SLEEP_SCORE: insufficient("SLEEP_SCORE"),
    FITNESS_AGE: insufficient("FITNESS_AGE"),
    VASCULAR_AGE_DELTA: insufficient("VASCULAR_AGE_DELTA"),
    HRV_BALANCE: insufficient("HRV_BALANCE"),
    BMI: insufficient("BMI"),
    SIX_MINUTE_WALK_BAND: insufficient("SIX_MINUTE_WALK_BAND"),
  };
  for (const type of SECTION_VITALS) {
    if (type === "HEART_RATE_VARIABILITY") continue;
    const [center, spread] = VITAL_BANDS[type] ?? [50, 5];
    metrics[`VITALS_BASELINE:${type}`] = vitalsBaseline(type, center, spread);
  }
  for (const { metric } of SECTION_MOBILITY) {
    metrics[metric] = insufficient(metric);
  }
  return metrics;
}

/**
 * Route-mock a populated Insights overview onto `page`.
 *
 * Only the reads that decide whether a section renders AT ALL are stubbed;
 * everything else (the i18n bundle, every layout decision, the real component
 * tree) stays authentic, so the geometry under test is the shipped geometry.
 */
export async function mockPopulatedInsights(page: Page): Promise<void> {
  // Without a non-empty comprehensive payload the page short-circuits to its
  // "no data yet" empty state and no section mounts at all.
  // RegExp matchers throughout, not globs: Playwright's URL glob treats `?` as
  // a single-character wildcard, so `**/api/insights/derived?*` also matches
  // `/api/insights/derived/batch?…` and the two handlers shadow each other.
  await page.route(/\/api\/insights\/comprehensive(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          totalMeasurements: 4821,
          moodSummary: { count: 96 },
          medications: [{ id: "med-1" }, { id: "med-2" }, { id: "med-3" }],
        },
        error: null,
      }),
    }),
  );

  // The batched derived read behind the wellness strip + the vitals grid.
  await page.route(/\/api\/insights\/derived\/batch(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { metrics: buildBatchMetrics() },
        error: null,
      }),
    }),
  );

  // The single-metric derived route. Only COINCIDENT_DEVIATION is stubbed —
  // it is the card whose heading carries the provenance sentence. Any other
  // metric falls through to the real handler.
  await page.route(/\/api\/insights\/derived\?/, async (route) => {
    const metric = new URL(route.request().url()).searchParams.get("metric");
    if (metric !== "COINCIDENT_DEVIATION") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: COINCIDENT_FIRED, error: null }),
    });
  });
}
