import { describe, expect, it } from "vitest";

import { gradeBpScore } from "@/lib/analytics/bp-grade";
import { computeActivityPillar } from "../activity";
import { computeAdiposityPillar } from "../adiposity";
import { computeBloodPressurePillar } from "../blood-pressure";
import { computeFitnessPillar } from "../fitness";
import { computeGlycaemiaPillar } from "../glycaemia";
import { computeLipidsPillar } from "../lipids";
import { computeSleepPillar } from "../sleep";
import { computeWellbeingPillar } from "../wellbeing";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const live = {
  source: "live" as const,
  readFailed: false,
  timezone: "Europe/Berlin",
};

function days(count: number, value: number) {
  return Array.from({ length: count }, (_, index) => ({
    day: new Date(NOW.getTime() - index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    value,
  }));
}

describe("reference-score pillars", () => {
  it("requires twelve fresh paired blood-pressure readings", () => {
    const below = computeBloodPressurePillar({
      ...live,
      pairCount: 11,
      graded: gradeBpScore({
        sys: 129,
        dia: 79,
        target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      }),
      representative: { sys: 129, dia: 79 },
      oldestAt: new Date("2026-07-01T08:00:00Z"),
      latestAt: new Date("2026-07-27T08:00:00Z"),
      target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      sources: ["MANUAL"],
      asOf: NOW,
    });
    expect(below.status).toBe("insufficient");
    expect(below.coverage.presentInputs).toBe(11);

    const eligible = computeBloodPressurePillar({
      ...live,
      pairCount: 12,
      graded: gradeBpScore({
        sys: 129,
        dia: 79,
        target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      }),
      representative: { sys: 129, dia: 79 },
      oldestAt: new Date("2026-07-01T08:00:00Z"),
      latestAt: new Date("2026-07-27T08:00:00Z"),
      target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      sources: ["MANUAL"],
      asOf: NOW,
    });
    expect(eligible.status).toBe("ok");
    if (eligible.status === "ok") {
      expect(eligible.value.score).toBe(85);
      expect(eligible.value.reference.source).toBe("ESH 2023");
    }
  });

  it("keeps BP scoring clinical while exposing a different personal band", () => {
    const result = computeBloodPressurePillar({
      ...live,
      pairCount: 12,
      graded: gradeBpScore({
        sys: 129,
        dia: 79,
        target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      }),
      representative: { sys: 129, dia: 79 },
      oldestAt: new Date("2026-07-01T08:00:00Z"),
      latestAt: new Date("2026-07-27T08:00:00Z"),
      target: { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 },
      personalTarget: {
        sysLow: 115,
        sysHigh: 125,
        diaLow: 65,
        diaHigh: 75,
      },
      sources: ["MANUAL"],
      asOf: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(85);
      expect(result.value.reference.label).toBe("120–129/70–79 mmHg");
      expect(result.value.personalReference?.label).toBe("115–125/65–75 mmHg");
    }
  });

  it("prefers a fresh HbA1c result and applies the lower reference floor", () => {
    const result = computeGlycaemiaPillar({
      ...live,
      asOf: NOW,
      hba1c: [
        {
          value: 4.5,
          unit: "%",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
      ],
      fastingGlucose: days(12, 92).map((point) => ({
        value: point.value,
        at: new Date(`${point.day}T08:00:00Z`),
        source: "APPLE_HEALTH",
      })),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.observed.label).toContain("HbA1c");
      expect(result.value.reference.low).toBe(5);
      expect(result.value.score).toBeLessThan(100);
      expect(result.value.deltaEligible).toBe(false);
    }
  });

  it("uses eight fasting readings only when HbA1c is absent", () => {
    const below = computeGlycaemiaPillar({
      ...live,
      asOf: NOW,
      hba1c: [],
      fastingGlucose: days(7, 92).map((point) => ({
        value: point.value,
        at: new Date(`${point.day}T08:00:00Z`),
        source: "APPLE_HEALTH",
      })),
    });
    expect(below.status).toBe("insufficient");

    const eligible = computeGlycaemiaPillar({
      ...live,
      asOf: NOW,
      hba1c: [],
      fastingGlucose: days(8, 92).map((point) => ({
        value: point.value,
        at: new Date(`${point.day}T08:00:00Z`),
        source: "APPLE_HEALTH",
      })),
    });
    expect(eligible.status).toBe("ok");
  });

  it("does not use fasting fallback when the preferred lab read failed", () => {
    const result = computeGlycaemiaPillar({
      ...live,
      asOf: NOW,
      hba1cReadFailed: true,
      hba1c: [],
      fastingGlucose: days(8, 92).map((point) => ({
        value: point.value,
        at: new Date(`${point.day}T08:00:00Z`),
        source: "APPLE_HEALTH",
      })),
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("read_failed");
    }
  });

  it("requires 21 activity days and saturates at the age-specific step plateau", () => {
    expect(
      computeActivityPillar({
        ...live,
        asOf: NOW,
        ageYears: 40,
        days: days(20, 10_000),
        sources: ["APPLE_HEALTH"],
      }).status,
    ).toBe("insufficient");

    const younger = computeActivityPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      days: days(21, 12_000),
      sources: ["APPLE_HEALTH"],
    });
    const older = computeActivityPillar({
      ...live,
      asOf: NOW,
      ageYears: 68,
      days: days(21, 8_000),
      sources: ["APPLE_HEALTH"],
    });
    expect(younger.status).toBe("ok");
    expect(older.status).toBe("ok");
    if (younger.status === "ok" && older.status === "ok") {
      expect(younger.value.score).toBe(100);
      expect(older.value.score).toBe(100);
      expect(younger.value.reference.high).toBe(10_000);
      expect(older.value.reference.high).toBe(8_000);
    }
  });

  it("keeps activity scores identical across rollup and live provenance", () => {
    const input = {
      readFailed: false,
      asOf: NOW,
      timezone: "Europe/Berlin",
      ageYears: 40,
      days: days(21, 8_500),
      sources: ["APPLE_HEALTH"],
    };
    const liveResult = computeActivityPillar({ ...input, source: "live" });
    const rollupResult = computeActivityPillar({ ...input, source: "DAY" });
    expect(liveResult.status).toBe("ok");
    expect(rollupResult.status).toBe("ok");
    if (liveResult.status === "ok" && rollupResult.status === "ok") {
      expect(rollupResult.value.score).toBe(liveResult.value.score);
      expect(rollupResult.provenance.source).toBe("DAY");
      expect(liveResult.provenance.source).toBe("live");
    }
  });

  it("scores exactly 28 activity calendar keys", () => {
    const points = days(29, 10_000);
    points[28] = { ...points[28], value: 0 };
    const result = computeActivityPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      days: points,
      sources: ["APPLE_HEALTH"],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.score).toBe(100);
  });

  it("requires fourteen sleep nights, never penalises long sleep, and adds regularity at 21 nights", () => {
    const below = computeSleepPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      nights: days(13, 480).map((point, index) => ({
        night: point.day,
        asleepMinutes: point.value,
        midpoint: 180 + index,
      })),
      sources: ["APPLE_HEALTH"],
    });
    expect(below.status).toBe("insufficient");

    const longSleep = computeSleepPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      nights: days(21, 600).map((point) => ({
        night: point.day,
        asleepMinutes: point.value,
        midpoint: 180,
      })),
      sources: ["APPLE_HEALTH"],
    });
    expect(longSleep.status).toBe("ok");
    if (longSleep.status === "ok") {
      expect(longSleep.value.score).toBe(100);
      expect(longSleep.value.reference.high).toBeNull();
    }
  });

  it("scores exactly 28 sleep calendar keys", () => {
    const nights = days(29, 600).map((point) => ({
      night: point.day,
      asleepMinutes: point.value,
      midpoint: 180,
    }));
    nights[28] = { ...nights[28], asleepMinutes: 0 };
    const result = computeSleepPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      nights,
      sources: ["APPLE_HEALTH"],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.score).toBe(100);
  });

  it("scores waist-to-height only from a fresh waist-derived value", () => {
    const result = computeAdiposityPillar({
      ...live,
      asOf: NOW,
      heightCm: 180,
      rows: [
        {
          type: "WAIST_CIRCUMFERENCE",
          value: 90,
          unit: "cm",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.observed.value).toBe(0.5);
      expect(result.value.reference.high).toBe(0.5);
      expect(result.value.reference.source).toBe("NICE 2022");
    }
  });

  it("uses the freshest complete adiposity signal", () => {
    const result = computeAdiposityPillar({
      ...live,
      asOf: NOW,
      heightCm: 180,
      rows: [
        {
          type: "WAIST_TO_HEIGHT",
          value: 0.6,
          unit: "ratio",
          at: new Date("2026-06-01T08:00:00Z"),
          source: "MANUAL",
        },
        {
          type: "WAIST_CIRCUMFERENCE",
          value: 90,
          unit: "cm",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.observed.value).toBe(0.5);
      expect(result.value.observed.asOf).toContain("2026-07-20");
    }
  });

  it("suppresses a PHQ-9 result when item 9 was flagged", () => {
    const result = computeWellbeingPillar({
      ...live,
      asOf: NOW,
      assessments: [
        {
          instrument: "PHQ9",
          totalScore: 3,
          item9Flagged: true,
          at: new Date("2026-07-20T08:00:00Z"),
        },
      ],
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("crisis_signposting");
    }
  });

  it("scores validated wellbeing instruments on their published scales", () => {
    const phq = computeWellbeingPillar({
      ...live,
      asOf: NOW,
      assessments: [
        {
          instrument: "PHQ9",
          totalScore: 4,
          item9Flagged: false,
          at: new Date("2026-07-20T08:00:00Z"),
        },
      ],
    });
    const who = computeWellbeingPillar({
      ...live,
      asOf: NOW,
      assessments: [
        {
          instrument: "WHO5",
          totalScore: 52,
          item9Flagged: false,
          at: new Date("2026-07-20T08:00:00Z"),
        },
      ],
    });
    expect(phq.status).toBe("ok");
    expect(who.status).toBe("ok");
    if (phq.status === "ok") expect(phq.value.score).toBe(85);
    if (who.status === "ok") expect(who.value.score).toBe(52);
  });

  it("admits fitness only when the source proves a measured test", () => {
    const unverified = computeFitnessPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      sex: "MALE",
      rows: [
        {
          value: 42,
          at: new Date("2026-07-20T08:00:00Z"),
          source: "APPLE_HEALTH",
          measured: false,
        },
      ],
    });
    expect(unverified.status).toBe("insufficient");

    const measured = computeFitnessPillar({
      ...live,
      asOf: NOW,
      ageYears: 40,
      sex: "MALE",
      rows: [
        {
          value: 42,
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
          measured: true,
        },
      ],
    });
    expect(measured.status).toBe("ok");
    if (measured.status === "ok") {
      expect(measured.value.reference.source).toBe("FRIEND (Kaminsky 2015)");
    }
  });

  it("requires a fresh lipid panel with lab-reported reference bounds", () => {
    const result = computeLipidsPillar({
      ...live,
      asOf: NOW,
      rows: [
        {
          marker: "LDL",
          value: 120,
          unit: "mg/dL",
          referenceLow: 0,
          referenceHigh: 130,
          panel: "Lipids",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
        {
          marker: "HDL",
          value: 50,
          unit: "mg/dL",
          referenceLow: 40,
          referenceHigh: null,
          panel: "Lipids",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(100);
      expect(result.value.observed.label).toContain("LDL 120 mg/dL");
    }
  });

  it("accepts one fresh lipid panel result with a reported range", () => {
    const result = computeLipidsPillar({
      ...live,
      asOf: NOW,
      rows: [
        {
          marker: "LDL",
          value: 120,
          unit: "mg/dL",
          referenceLow: 0,
          referenceHigh: 130,
          panel: "Lipids",
          at: new Date("2026-07-20T08:00:00Z"),
          source: "MANUAL",
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.coverage.requiredInputs).toBe(1);
      expect(result.value.observed.value).toBe(1);
    }
  });

  it("keeps stale data absent for every sparse pillar", () => {
    const staleAt = new Date("2025-01-01T08:00:00Z");
    expect(
      computeGlycaemiaPillar({
        ...live,
        asOf: NOW,
        hba1c: [{ value: 5.3, unit: "%", at: staleAt, source: "MANUAL" }],
        fastingGlucose: [],
      }).status,
    ).toBe("insufficient");
    expect(
      computeFitnessPillar({
        ...live,
        asOf: NOW,
        ageYears: 40,
        sex: "MALE",
        rows: [{ value: 42, at: staleAt, source: "MANUAL", measured: true }],
      }).status,
    ).toBe("insufficient");
    expect(
      computeLipidsPillar({
        ...live,
        asOf: NOW,
        rows: [
          {
            marker: "LDL",
            value: 120,
            unit: "mg/dL",
            referenceLow: 0,
            referenceHigh: 130,
            panel: "Lipids",
            at: staleAt,
            source: "MANUAL",
          },
        ],
      }).status,
    ).toBe("insufficient");
  });
});
