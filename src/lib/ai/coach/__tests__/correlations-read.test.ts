/**
 * v1.21.0 (C3) — the Coach correlations reader surfaces the deterministic FDR
 * discovery + coincident-deviation flag, returns descriptive driver rows, and
 * degrades to a clean { present: false } when nothing survives or a read fails.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const measurementFindMany = vi.fn();
const moodFindMany = vi.fn();
const userFindUnique = vi.fn();
const medicationFindMany = vi.fn();
const intakeEventFindMany = vi.fn();
const illnessEpisodeFindMany = vi.fn();
const illnessDayLogFindMany = vi.fn();
const labResultFindMany = vi.fn();
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    medication: { findMany: (a: unknown) => medicationFindMany(a) },
    medicationIntakeEvent: { findMany: (a: unknown) => intakeEventFindMany(a) },
    illnessEpisode: { findMany: (a: unknown) => illnessEpisodeFindMany(a) },
    illnessDayLog: { findMany: (a: unknown) => illnessDayLogFindMany(a) },
    labResult: { findMany: (a: unknown) => labResultFindMany(a) },
  },
}));

const loadBaselineProfile = vi.fn();
const computeCoincidentDeviation = vi.fn();
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    loadBaselineProfile: () => loadBaselineProfile(),
    computeCoincidentDeviation: () => computeCoincidentDeviation(),
  };
});

const discoverCorrelations = vi.fn();
vi.mock("@/lib/insights/correlation-discovery", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/insights/correlation-discovery")
    >();
  return {
    ...actual,
    discoverCorrelations: (...args: unknown[]) => discoverCorrelations(...args),
  };
});

import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";

describe("readCoachCorrelations", () => {
  beforeEach(() => {
    measurementFindMany.mockReset().mockResolvedValue([]);
    moodFindMany.mockReset().mockResolvedValue([]);
    userFindUnique.mockReset().mockResolvedValue({ timezone: "Europe/Berlin" });
    medicationFindMany.mockReset().mockResolvedValue([]);
    intakeEventFindMany.mockReset().mockResolvedValue([]);
    illnessEpisodeFindMany.mockReset().mockResolvedValue([]);
    illnessDayLogFindMany.mockReset().mockResolvedValue([]);
    labResultFindMany.mockReset().mockResolvedValue([]);
    loadBaselineProfile
      .mockReset()
      .mockResolvedValue({ ageYears: 40, sex: "MALE", heightCm: 180 });
    computeCoincidentDeviation.mockReset().mockResolvedValue(null);
    discoverCorrelations.mockReset();
  });

  it("returns descriptive drivers when pairs survive", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [
        {
          behaviour: "TIME_IN_DAYLIGHT",
          outcome: "SLEEP_DURATION",
          n: 42,
          r: 0.34,
          pValue: 0.001,
          qValue: 0.02,
          interpretation:
            "Higher time in daylight tends to go with higher next-day sleep duration in your data — a pattern worth watching, not a cause.",
          lagDays: 1,
        },
      ],
      pairsTested: 18,
      fdrQ: 0.1,
      minPairs: 20,
    });
    const result = await readCoachCorrelations("u1", "en");
    expect(result.present).toBe(true);
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers?.[0]).toMatchObject({
      behaviour: "time in daylight",
      outcome: "sleep duration",
      direction: "higher",
      lagDays: 1,
      n: 42,
    });
    expect(result.pairsTested).toBe(18);
  });

  it("returns present:false when nothing survives and no coincident flag", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [],
      pairsTested: 4,
      fdrQ: 0.1,
      minPairs: 20,
    });
    const result = await readCoachCorrelations("u1", "en");
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_significant_pattern");
  });

  it("surfaces a fired coincident flag even without drivers", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [],
      pairsTested: 4,
      fdrQ: 0.1,
      minPairs: 20,
    });
    computeCoincidentDeviation.mockResolvedValue({
      status: "ok",
      value: {
        fired: true,
        vitals: [],
        contributing: [
          { type: "RESTING_HEART_RATE", direction: "above" },
          { type: "HEART_RATE_VARIABILITY", direction: "below" },
        ],
        day: "2026-06-02",
        illnessExplained: false,
      },
      coverage: {
        requiredInputs: 2,
        presentInputs: 2,
        historyDays: 30,
        missing: [],
      },
      confidence: { score: 80, band: "high" },
      provenance: {
        inputs: [],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    const result = await readCoachCorrelations("u1", "en");
    expect(result.present).toBe(true);
    expect(result.coincident?.fired).toBe(true);
    expect(result.coincident?.contributing).toEqual([
      { metric: "resting heart rate", direction: "above" },
      { metric: "heart rate variability", direction: "below" },
    ]);
  });

  it("degrades to present:false on a read failure", async () => {
    loadBaselineProfile.mockRejectedValue(new Error("db down"));
    const result = await readCoachCorrelations("u1", "en");
    expect(result.present).toBe(false);
    expect(result.reason).toBe("retrieval_failed");
  });

  // INTEGFIX — the measurement query must only ever carry real MeasurementType
  // enum values; the three non-measurement channels (MOOD + the two new ones)
  // are dropped, so the Postgres enum cast can never throw on a channel key.
  it("never splices a non-measurement channel key into the type IN(...) filter", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [],
      pairsTested: 0,
      fdrQ: 0.1,
      minPairs: 20,
    });
    await readCoachCorrelations("u1", "en");
    const where = measurementFindMany.mock.calls[0]?.[0]?.where as {
      type: { in: string[] };
    };
    const types = where.type.in;
    expect(types).not.toContain("MOOD");
    expect(types).not.toContain("MEDICATION_COMPLIANCE");
    expect(types).not.toContain("SYMPTOM_SEVERITY");
    // The real enum channels are still present.
    expect(types).toContain("SLEEP_DURATION");
  });

  // INTEGFIX — drive the REAL discovery engine end-to-end with illness data so
  // the SYMPTOM_SEVERITY channel flows through the non-enum query path and
  // surfaces as a descriptive driver (proving the reader no longer throws an
  // enum-cast error on a user with symptom data).
  it("surfaces a symptom-severity driver through the real engine without an enum-cast error", async () => {
    const real = await vi.importActual<
      typeof import("@/lib/insights/correlation-discovery")
    >("@/lib/insights/correlation-discovery");
    discoverCorrelations.mockImplementation((series) =>
      real.discoverCorrelations(
        series as Parameters<typeof real.discoverCorrelations>[0],
        { locale: "en" },
      ),
    );

    // 45 consecutive days. Symptom burden (behaviour, day D) drives next-day
    // sleep (outcome, day D+1) with a strong, deterministic linear relationship
    // so the pair clears n ≥ 20 / p < 0.05 / FDR / effect-size floor.
    const DAYS = 45;
    const base = Date.UTC(2026, 4, 1, 12, 0, 0); // midday → tz-stable day key
    const dayKey = (offset: number): string => {
      const d = new Date(base + offset * 86_400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    const dayLogs: Array<{
      date: string;
      functionalImpact: number;
      symptomLinks: Array<{ severity: number }>;
    }> = [];
    const measurements: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < DAYS; i++) {
      const burden = i % 4; // 0..3, real 0↔>0 variance
      dayLogs.push({
        date: dayKey(i),
        functionalImpact: burden,
        symptomLinks: [],
      });
      // Next-day sleep falls as today's burden rises (8h baseline − burden).
      measurements.push({
        type: "SLEEP_DURATION",
        value: 8 - burden,
        measuredAt: new Date(base + (i + 1) * 86_400_000),
      });
    }

    measurementFindMany.mockResolvedValue(measurements);
    // One episode spanning the whole window so the builder zero-fills/overlays
    // every logged day.
    illnessEpisodeFindMany.mockResolvedValue([
      {
        id: "ep1",
        onsetAt: new Date(base),
        resolvedAt: new Date(base + DAYS * 86_400_000),
      },
    ]);
    illnessDayLogFindMany.mockResolvedValue(dayLogs);

    const result = await readCoachCorrelations("u1", "en");

    expect(result.present).toBe(true);
    const symptomDriver = result.drivers?.find(
      (d) =>
        d.behaviour === "symptom severity" || d.outcome === "symptom severity",
    );
    expect(symptomDriver).toBeDefined();
    expect(symptomDriver?.outcome).toBe("sleep duration");
    expect(symptomDriver?.n).toBeGreaterThanOrEqual(20);
  });
});
