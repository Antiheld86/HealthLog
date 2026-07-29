import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import {
  HealthScoreCard,
  markAlgorithmNoticeDismissed,
} from "../health-score-card";
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

function render(report: HealthScoreReport, locale: Locale = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <HealthScoreCard report={report} />
    </I18nProvider>,
  );
}

function report(overrides: Partial<HealthScoreReport> = {}): HealthScoreReport {
  return {
    composite: {
      status: "insufficient",
      coverage,
      provenance,
      reason: "three_domains_required",
    },
    pillars: [
      {
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
      },
      {
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
      },
    ],
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

beforeEach(() => {
  mockAuthUser = { unitPreference: "metric", glucoseUnit: "mg/dL" };
});

describe("<HealthScoreCard>", () => {
  it("keeps below-floor pillars visible without a composite headline", () => {
    const html = render(report());
    expect(html).toContain('data-status="insufficient"');
    expect(html).toContain('data-contributor="BLOOD_PRESSURE"');
    expect(html).toContain('data-contributor="ACTIVITY"');
    expect(html).toContain("Not enough recent eligible data");
    expect(html).not.toContain("below_day_floor_or_stale");
    expect(html).toContain("Your target: 115 to 125/65 to 75 mmHg");
    expect(html).not.toContain('data-slot="score-ring"');
  });

  it("shows personal goal progress as explicitly unscored context", () => {
    const html = render(
      report({
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
      }),
    );
    expect(html).toContain('data-slot="health-score-weight-goal"');
    expect(html).toContain('data-status="ok"');
    expect(html).toContain("does not affect the Health Score");
  });

  it("renders the personal weight goal in the account unit system", () => {
    mockAuthUser = { unitPreference: "imperial", glucoseUnit: "mg/dL" };
    const html = render(
      report({
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
      }),
    );
    expect(html).toContain("178.6 lb now");
    expect(html).toContain("Goal 163.1 to 172 lb");
    expect(html).toContain("6.6 lb");
    expect(html).not.toContain("81 kg");
  });

  it("renders fasting glucose and its reference in the account unit", () => {
    mockAuthUser = { unitPreference: "metric", glucoseUnit: "mmol/L" };
    const base = report();
    const html = render(
      report({
        pillars: [
          {
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
          },
          ...base.pillars.slice(1),
        ],
      }),
    );
    expect(html).toContain("Fasting glucose: 5.5 mmol/L");
    expect(html).toContain("3.9 to 5.5 mmol/L fasting");
    expect(html).not.toContain("100 mg/dL");
    expect(html).not.toContain("70 to 99 mg/dL");
  });

  it("shows one headline score without algorithm, method, or composition copy", () => {
    const html = render(
      scoredReport({
        algorithmNotice: {
          itemKey: "health_score_algorithm:2",
          dismissed: false,
        },
      }),
    );

    expect(html.match(/>86</g)).toHaveLength(1);
    expect(html).not.toContain('data-slot="health-score-algorithm-notice"');
    expect(html).not.toContain("cardiometabolic reference ranges");
    expect(html).not.toContain("Equal-weight average of eligible pillars");
    expect(html).not.toContain("The lowest pillar sets the overall band");
    expect(html).not.toContain("Included:");

    // Presentation cleanup must not sever score identity or source detail.
    expect(html).toContain("Method version 2");
    expect(html).toContain('data-slot="health-score-pillars"');
    expect(html).toContain("ESH 2023");
    expect(html).toContain('data-slot="health-score-delta"');
  });

  it("localises structured activity labels, references, and reasons", () => {
    const base = report();
    const html = render(
      report({
        pillars: [
          {
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
          },
          ...base.pillars.slice(1),
        ],
      }),
      "de",
    );
    expect(html).toContain("Schritte pro Tag");
    expect(html).toContain("Der Nutzen flacht");
    expect(html).toContain("Leitlinienbereich");
    expect(html).not.toContain("benefit plateaus by");
    expect(html).not.toContain("guideline-band");
  });
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
