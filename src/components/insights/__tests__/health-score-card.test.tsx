import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type {
  HealthScoreReport,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import {
  HealthScoreCard,
  HealthScoreCardSkeleton,
  markAlgorithmNoticeDismissed,
} from "../health-score-card";
import {
  pillarDetailLines,
  pillarObservedText,
  type Translate,
} from "../health-score-pillar-detail";

let mockAuthUser: { unitPreference: string; glucoseUnit: string } = {
  unitPreference: "metric",
  glucoseUnit: "mg/dL",
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockAuthUser,
  }),
}));

const provenance = {
  inputs: ["BLOOD_PRESSURE"],
  source: "live" as const,
  windowDays: 90,
  computedAt: "2026-07-28T12:00:00.000Z",
};
const coverage = {
  requiredInputs: 3,
  presentInputs: 1,
  historyDays: 7,
  missing: ["ACTIVITY", "SLEEP"],
};

function render(node: React.ReactNode, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * The pillar detail lines live behind a Radix popover, which only mounts its
 * body once opened, so they are asserted through the pure formatter the card
 * feeds the popover. Lifting the live translator out of a throwaway render
 * keeps those assertions on the SAME strings the card shows rather than a
 * second copy of the copy.
 */
function translator(locale: Locale = "en"): Translate {
  let captured: Translate | null = null;
  function Probe() {
    captured = useTranslations().t;
    return null;
  }
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <Probe />
    </I18nProvider>,
  );
  if (!captured) throw new Error("translator probe did not run");
  return captured;
}

const BLOOD_PRESSURE: ScorePillarResult = {
  id: "BLOOD_PRESSURE",
  domain: "cardiometabolic",
  result: {
    status: "ok",
    value: {
      score: 82,
      observed: {
        value: 126,
        unit: "mmHg",
        label: "126/78 mmHg",
        asOf: "2026-07-27T08:00:00.000Z",
        sources: ["MANUAL"],
      },
      reference: {
        kind: "clinical-threshold",
        low: 120,
        high: 129,
        label: "120 to 129/70 to 79 mmHg",
        source: "ESH 2023",
      },
      personalReference: {
        kind: "guideline-band",
        low: 115,
        high: 125,
        label: "115 to 125/65 to 75 mmHg",
        source: "personal target",
      },
      noiseFloor: 1,
      deltaEligible: true,
      deltaIdentity: "graded_bp_pair_series",
    },
    coverage: {
      requiredInputs: 12,
      presentInputs: 12,
      historyDays: 28,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance,
  },
};

const ACTIVITY_BELOW_FLOOR: ScorePillarResult = {
  id: "ACTIVITY",
  domain: "activity",
  result: {
    status: "insufficient",
    coverage: {
      requiredInputs: 21,
      presentInputs: 7,
      historyDays: 7,
      missing: ["14 days"],
    },
    provenance: { ...provenance, inputs: ["ACTIVITY"], windowDays: 28 },
    reason: "below_day_floor_or_stale",
  },
};

const FASTING_GLUCOSE: ScorePillarResult = {
  id: "GLYCAEMIA",
  domain: "cardiometabolic",
  result: {
    status: "ok",
    value: {
      score: 80,
      observed: {
        value: 100,
        unit: "mg/dL",
        label: "Fasting glucose",
        asOf: "2026-07-27T08:00:00.000Z",
        sources: ["MANUAL"],
      },
      reference: {
        kind: "clinical-threshold",
        low: 70,
        high: 99,
        label: "70 to 99 mg/dL fasting",
        source: "ADA 2026",
      },
      noiseFloor: 1,
      deltaEligible: true,
      deltaIdentity: "fasting_glucose",
    },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 1,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance,
  },
};

function gatedPillar(
  id: ScorePillarResult["id"],
  reason: string,
): ScorePillarResult {
  return {
    id,
    domain: "wellbeing",
    result: {
      status: "insufficient",
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: [],
      },
      provenance: { ...provenance, inputs: [id] },
      reason,
    },
  };
}

function report(overrides: Partial<HealthScoreReport> = {}): HealthScoreReport {
  return {
    composite: {
      status: "insufficient",
      coverage,
      provenance,
      reason: "three_domains_required",
    },
    pillars: [BLOOD_PRESSURE, ACTIVITY_BELOW_FLOOR],
    delta: null,
    deltaReason: "no_current_score",
    scoreVersion: 2,
    weightGoal: {
      status: "insufficient",
      coverage: {
        requiredInputs: 2,
        presentInputs: 0,
        historyDays: 0,
        missing: ["weight reading", "personal weight target"],
      },
      provenance: { ...provenance, inputs: ["WEIGHT"] },
      reason: "no_personal_goal",
    },
    algorithmNotice: null,
    ...overrides,
  };
}

function scoredReport(
  overrides: Partial<HealthScoreReport> = {},
): HealthScoreReport {
  return report({
    composite: {
      status: "ok",
      value: {
        score: 86,
        band: "green",
        bandSetter: null,
        composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
        noiseFloor: 3,
        scoreVersion: 2,
      },
      coverage: {
        requiredInputs: 3,
        presentInputs: 3,
        historyDays: 28,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance: {
        ...provenance,
        inputs: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      },
    },
    delta: 2,
    deltaReason: null,
    ...overrides,
  });
}

/** The markup between the disclosure region's open tag and the card's end. */
function anatomyRegion(html: string): string {
  const start = html.indexOf('data-slot="health-score-anatomy-region"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

beforeEach(() => {
  mockAuthUser = { unitPreference: "metric", glucoseUnit: "mg/dL" };
});

describe("<HealthScoreCard> disclosure", () => {
  it("opens collapsed: the breakdown is present but hidden and out of tab order", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    expect(html).toMatch(
      /aria-expanded="false"[^>]*data-slot="health-score-anatomy-toggle"/,
    );
    // The trigger points at the region it controls, and the region is `hidden`
    // rather than unmounted, so opening it is a paint, not a fetch.
    const controls = html.match(/aria-controls="([^"]+)"/);
    expect(controls).not.toBeNull();
    expect(html).toContain(`id="${controls![1]}" hidden=""`);
    expect(anatomyRegion(html)).toContain('data-slot="health-score-pillars"');
  });

  it("keeps the score face outside the disclosure", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const face = html.slice(
      0,
      html.indexOf('data-slot="health-score-anatomy-toggle"'),
    );
    expect(face).toContain('data-slot="health-score-band"');
    expect(face).toContain('data-slot="health-score-delta"');
    expect(face).toContain(">86<");
    // The pillar grid and the method footer belong to the opened region only.
    expect(face).not.toContain('data-slot="health-score-pillars"');
    expect(face).not.toContain('data-slot="health-score-method"');
  });
});

describe("<HealthScoreCard> pillars", () => {
  it("grids the scored pillars only and never draws a gated one as a cell", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const region = anatomyRegion(html);
    expect(region).toContain("sm:grid-cols-2");
    expect(region).toContain("lg:grid-cols-3");
    expect(region).toContain('data-pillar="BLOOD_PRESSURE" data-status="ok"');
    expect(region).not.toContain('data-pillar="ACTIVITY" data-status="ok"');
    // Blood pressure scores 82, so its impact bar is band-green at 82%.
    expect(region).toContain("width:82%");
    expect(region).toContain("bg-success");
  });

  it("names every gated pillar with its reason instead of scoring it zero", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-not-scored"');
    expect(region).toContain("Not scored yet (1)");
    expect(region).toContain('data-reason="below_day_floor_or_stale"');
    expect(region).toContain("Not enough recent eligible data");
    expect(region).not.toContain("below_day_floor_or_stale<");
  });

  it("treats a failed read as an error with a retry, never as absence", () => {
    const retry = vi.fn();
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          pillars: [
            BLOOD_PRESSURE,
            gatedPillar("SLEEP", "read_failed"),
            ACTIVITY_BELOW_FLOOR,
          ],
        })}
        onRetry={retry}
      />,
    );
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-pillar-error"');
    expect(region).toContain('role="alert"');
    expect(region).toContain('data-slot="health-score-pillar-retry"');
    expect(region).toContain("Data could not be loaded");
    // A failed read is NOT absence, so it stays out of the "not scored" list.
    expect(region).toContain("Not scored yet (1)");
    expect(region).not.toContain('data-reason="read_failed"');
  });

  it("leads the gated list with safety signposting", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          pillars: [
            BLOOD_PRESSURE,
            ACTIVITY_BELOW_FLOOR,
            gatedPillar("WELLBEING", "crisis_signposting"),
          ],
        })}
      />,
    );
    const region = anatomyRegion(html);
    expect(region).toContain("Not scored yet (2)");
    const crisis = region.indexOf('data-reason="crisis_signposting"');
    const activity = region.indexOf('data-reason="below_day_floor_or_stale"');
    expect(crisis).toBeGreaterThan(-1);
    expect(crisis).toBeLessThan(activity);
    expect(region).toContain("Safety guidance is shown instead of a score");
  });
});

describe("<HealthScoreCard> composite states", () => {
  it("shows a provisional ring and the learning gate when the composite is gated", () => {
    const html = render(<HealthScoreCard report={report()} />);
    expect(html).toMatch(
      /data-slot="health-score-card"[^>]*data-status="insufficient"/,
    );
    expect(html).toContain('data-slot="health-score-insufficient"');
    expect(html).toContain(
      "The score needs at least three, including a measured physiological pillar.",
    );
    // No band sentence and no fabricated number in the face.
    expect(html).not.toContain('data-slot="health-score-band"');
    expect(html).toContain("Method version 2");
  });

  it("explains a missing comparison where the trend would be", () => {
    const html = render(<HealthScoreCard report={report()} />);
    expect(html).toContain('data-slot="health-score-delta-reason"');
    expect(html).toContain(
      "No comparison because the current window is not eligible.",
    );
    expect(html).not.toContain('data-slot="health-score-delta"');
  });

  it("annotates the number with Rest Mode and the ambient context lines", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          restMode: { active: true, since: "2026-07-20", episodeCount: 1 },
        })}
        tension={{ band: "yellow", positive: ["sleep"], negative: ["rhr"] }}
        returnToBand={{ metricType: "RESTING_HEART_RATE", daysInside: 6 }}
      />,
    );
    const face = html.slice(
      0,
      html.indexOf('data-slot="health-score-anatomy-toggle"'),
    );
    expect(face).toContain("Rest Mode active since 2026-07-20");
    expect(face).toContain('data-slot="health-score-tension"');
    expect(face).toContain('data-slot="health-score-return-to-band"');
    // The contributor key and the metric type are localised, never raw.
    expect(face).toContain("Resting heart rate");
    expect(face).not.toContain("RESTING_HEART_RATE");
    expect(face).not.toContain(">rhr<");
  });

  it("keeps a one-sided tension quiet", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport()}
        tension={{ band: "yellow", positive: ["sleep"], negative: [] }}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-tension"');
  });
});

describe("<HealthScoreCard> footer", () => {
  it("carries the band setter, the version and the cited method", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-method"');
    expect(region).toContain("Overall band set by none");
    expect(region).toContain("Method version 2. Weekly comparison floor");
    expect(region).toContain('data-slot="provenance-explainer-method"');
    expect(region).toContain("equal-weighted average");
  });

  it("shows the personal weight goal as explicitly unscored context", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          weightGoal: {
            status: "ok",
            value: {
              currentKg: 81,
              target: { min: 74, max: 78 },
              distanceKg: 3,
              deltaKg: 1,
              asOf: "2026-07-27T08:00:00.000Z",
              source: "MANUAL",
            },
            coverage: {
              requiredInputs: 2,
              presentInputs: 2,
              historyDays: 1,
              missing: [],
            },
            confidence: { score: 100, band: "high" },
            provenance,
          },
        })}
      />,
    );
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-weight-goal"');
    // The caption sits on the type scale, never the bespoke 11 px it carried
    // while the goal was a standalone card.
    expect(region).toContain(
      '<p class="text-muted-foreground mt-2 text-xs">Weight-goal progress is personal context and does not affect the Health Score.</p>',
    );
  });

  it("renders the personal weight goal in the account unit system", () => {
    mockAuthUser = { unitPreference: "imperial", glucoseUnit: "mg/dL" };
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          weightGoal: {
            status: "ok",
            value: {
              currentKg: 81,
              target: { min: 74, max: 78 },
              distanceKg: 3,
              deltaKg: 1,
              asOf: "2026-07-27T08:00:00.000Z",
              source: "MANUAL",
            },
            coverage: {
              requiredInputs: 2,
              presentInputs: 2,
              historyDays: 1,
              missing: [],
            },
            confidence: { score: 100, band: "high" },
            provenance,
          },
        })}
      />,
    );
    expect(html).toContain("178.6 lb now");
    expect(html).toContain("Goal 163.1 to 172 lb");
    expect(html).not.toContain("81 kg");
  });
});

describe("pillar detail formatting", () => {
  it("renders the observed line in the account glucose unit", () => {
    const html = render(
      <HealthScoreCard report={scoredReport({ pillars: [FASTING_GLUCOSE] })} />,
    );
    // The card mounts with mmol/L accounts too; the visible observed line is
    // the one always on screen.
    expect(html).toContain("Observed: Fasting glucose: 100 mg/dL");

    const mmol = pillarObservedText(FASTING_GLUCOSE, {
      t: translator(),
      glucoseUnit: "mmol/L",
    });
    expect(mmol).toBe("Fasting glucose: 5.5 mmol/L");
  });

  it("converts the reference band behind the popover into the account unit", () => {
    const lines = pillarDetailLines(FASTING_GLUCOSE, {
      t: translator(),
      glucoseUnit: "mmol/L",
    });
    expect(lines.join("\n")).toContain("3.9 to 5.5 mmol/L fasting");
    expect(lines.join("\n")).not.toContain("70 to 99 mg/dL");
  });

  it("keeps the reference, the personal target and the source together", () => {
    const lines = pillarDetailLines(BLOOD_PRESSURE, {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ESH 2023");
    expect(lines[1]).toContain("Your target: 115 to 125/65 to 75 mmHg");
    expect(lines[2]).toContain("Source: MANUAL");
  });

  it("localises the structured activity labels and references", () => {
    const activity: ScorePillarResult = {
      id: "ACTIVITY",
      domain: "activity",
      result: {
        status: "ok",
        value: {
          score: 80,
          observed: {
            value: 8_000,
            unit: "steps/day",
            label: "8,000 steps/day",
            asOf: "2026-07-27T00:00:00.000Z",
            sources: ["APPLE_HEALTH"],
          },
          reference: {
            kind: "guideline-band",
            low: 0,
            high: 10_000,
            label: "benefit plateaus by 10,000 steps/day",
            source: "Paluch 2022",
          },
          noiseFloor: 1,
          deltaEligible: true,
          deltaIdentity: "ACTIVITY_STEPS",
        },
        coverage: {
          requiredInputs: 21,
          presentInputs: 21,
          historyDays: 21,
          missing: [],
        },
        confidence: { score: 100, band: "high" },
        provenance,
      },
    };
    const de = { t: translator("de"), glucoseUnit: "mg/dL" as const };
    expect(pillarObservedText(activity, de)).toContain("Schritte pro Tag");
    const lines = pillarDetailLines(activity, de).join("\n");
    expect(lines).toContain("Der Nutzen flacht");
    expect(lines).toContain("Leitlinienbereich");
    expect(lines).not.toContain("benefit plateaus by");
    expect(lines).not.toContain("guideline-band");
  });
});

describe("<HealthScoreCardSkeleton>", () => {
  it("reserves the collapsed footprint and announces nothing", () => {
    const html = render(<HealthScoreCardSkeleton />);
    expect(html).toContain('data-slot="health-score-card-skeleton"');
    expect(html).toContain('aria-hidden="true"');
    // The `md` ring is a fixed 168 px box; the reserve matches it exactly.
    expect(html).toContain("size-[168px]");
  });
});

describe("markAlgorithmNoticeDismissed", () => {
  it("patches the cached analytics report after the notice is dismissed", () => {
    const payload = {
      healthScore: report({
        algorithmNotice: {
          itemKey: "health_score_algorithm:2",
          dismissed: false,
        },
      }),
    };
    const patched = markAlgorithmNoticeDismissed(
      payload,
      "health_score_algorithm:2",
    );
    expect(patched).toMatchObject({
      healthScore: {
        algorithmNotice: {
          itemKey: "health_score_algorithm:2",
          dismissed: true,
        },
      },
    });
  });
});
