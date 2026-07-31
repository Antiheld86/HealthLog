import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn(), count: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
  // Consent never blocks in these fixtures — the gate has its own tests.
  statusConsentBlocksGeneration: vi.fn(async () => false),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/insights/metric-correlation-context", () => ({
  getRelevantCorrelationsForMetric: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/tz/resolver", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tz/resolver")>(
      "@/lib/tz/resolver",
    );
  return { ...actual, resolveUserTimezone: vi.fn() };
});

vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { getRelevantCorrelationsForMetric } from "@/lib/insights/metric-correlation-context";
import { formatPreviousContextForPrompt } from "@/lib/insights/memory";
import { generateMetricStatus } from "../metric-status";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import {
  getMetricStatusMeta,
  metricStatusScope,
  METRIC_STATUS_IDS,
} from "../metric-status-registry";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { systemPrompt: string | null; userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { systemPrompt: string; userPrompt: string }) => {
      if (capture) {
        capture.systemPrompt = args.systemPrompt;
        capture.userPrompt = args.userPrompt;
      }
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  // resetAllMocks clears the module-mock default impls too — restore the
  // benign defaults so the relations fetch and the previous-context format
  // are no-ops unless a test overrides them.
  vi.mocked(getRelevantCorrelationsForMetric).mockResolvedValue([]);
  vi.mocked(formatPreviousContextForPrompt).mockReturnValue("");
  vi.mocked(resolveUserTimezone).mockResolvedValue("Europe/Berlin");
  vi.mocked(loadUserSourcePriority).mockResolvedValue(null as never);
});

describe("generateMetricStatus — SLEEP_DURATION night reconstruction (iOS E2)", () => {
  it("feeds the snapshot the per-night time-asleep total, not a single stage", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date("2026-06-04T07:00:00.000Z"),
    } as never);

    // One overnight session of granular stages, each row ONE stage (minutes).
    // Total time asleep = CORE + DEEP + REM = 300 + 90 + 75 = 465 min (7.75 h).
    // A single stage (DEEP, 90 min) is the largest, and an old per-row read
    // would have surfaced the LATEST stage (~75 min REM) as "current sleep".
    const wake = new Date("2026-06-04T06:30:00.000Z");
    const m = 60 * 1000;
    const stageRows = [
      {
        value: 300,
        measuredAt: new Date(wake.getTime() - 90 * m),
        sleepStage: "CORE",
        source: "APPLE_HEALTH",
      },
      {
        value: 90,
        measuredAt: new Date(wake.getTime() - 30 * m),
        sleepStage: "DEEP",
        source: "APPLE_HEALTH",
      },
      {
        value: 75,
        measuredAt: wake,
        sleepStage: "REM",
        source: "APPLE_HEALTH",
      },
    ];
    vi.mocked(prisma.measurement.count).mockResolvedValue(
      stageRows.length as never,
    );
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      stageRows as never,
    );

    const capture = { systemPrompt: null, userPrompt: null } as {
      systemPrompt: string | null;
      userPrompt: string | null;
    };
    stubCompletion("Summary: solide Nacht.", capture);

    const res = await generateMetricStatus({
      metric: "SLEEP_DURATION",
      userId: "u1",
      locale: "de",
      force: true,
    });

    expect(res.text).toBeTruthy();
    expect(capture.userPrompt).toBeTruthy();
    const prompt = capture.userPrompt as string;
    // The snapshot must carry the NIGHT total (465 min), never a lone stage.
    expect(prompt).toContain("465");
    expect(prompt).not.toContain('"value": 75');
    expect(prompt).not.toContain('"value": 90');
  });

  it("the snapshot graded series is the deduped night total, never the ~20 h raw-stage sum (A4)", async () => {
    // The ~20.3 h symptom: a source writes BOTH a bare ASLEEP aggregate AND the
    // granular CORE/DEEP/REM partition for the same span. Pre-fix the graded
    // `series` came from `buildGradedSeriesWithRollups`, which folds bare + each
    // granular stage + IN_BED + AWAKE into one day bucket (~1490 min ≈ 24.8 h).
    // Post-fix the graded series is built from the deduped per-night points, so
    // every recent bucket mean is the night total (480 min = 8 h).
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    // A recent night (last 24 h) so it lands in `graded.recent`.
    const wake = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const m = 60 * 1000;
    const stageRows = [
      {
        value: 480,
        measuredAt: wake,
        sleepStage: "ASLEEP",
        source: "APPLE_HEALTH",
      }, // bare aggregate
      {
        value: 240,
        measuredAt: new Date(wake.getTime() - 240 * m),
        sleepStage: "CORE",
        source: "APPLE_HEALTH",
      },
      {
        value: 120,
        measuredAt: new Date(wake.getTime() - 120 * m),
        sleepStage: "DEEP",
        source: "APPLE_HEALTH",
      },
      {
        value: 120,
        measuredAt: wake,
        sleepStage: "REM",
        source: "APPLE_HEALTH",
      },
      {
        value: 470,
        measuredAt: wake,
        sleepStage: "IN_BED",
        source: "APPLE_HEALTH",
      },
      {
        value: 20,
        measuredAt: new Date(wake.getTime() - 200 * m),
        sleepStage: "AWAKE",
        source: "APPLE_HEALTH",
      },
    ];
    vi.mocked(prisma.measurement.count).mockResolvedValue(
      stageRows.length as never,
    );
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      stageRows as never,
    );

    const capture = { systemPrompt: null, userPrompt: null } as {
      systemPrompt: string | null;
      userPrompt: string | null;
    };
    stubCompletion("Summary: solide Nacht.", capture);

    await generateMetricStatus({
      metric: "SLEEP_DURATION",
      userId: "u1",
      locale: "de",
      force: true,
    });

    const prompt = capture.userPrompt as string;
    const match = prompt.match(/\{[\s\S]*\}/);
    expect(match).toBeTruthy();
    const snapshot = JSON.parse(match![0]);
    const recent = snapshot.SLEEP_DURATION.series.recent as Array<{
      mean: number;
    }>;
    expect(recent.length).toBeGreaterThan(0);
    for (const bucket of recent) {
      // Night total (480 min = 8 h), never the impossible ~1490-min stage sum.
      expect(bucket.mean).toBeLessThanOrEqual(960); // ≤ 16 h
    }
    expect(recent.at(-1)?.mean).toBe(480);
  });
});

describe("metric-status registry", () => {
  it("excludes the seven specialised metrics from the generic set", () => {
    for (const excluded of [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "PULSE",
      "BMI",
      "MOOD",
      "MEDICATION",
    ]) {
      expect(METRIC_STATUS_IDS).not.toContain(excluded);
    }
  });

  it("scope id carries the metric: prefix and (with -status suffix) keeps the eviction substring", () => {
    expect(metricStatusScope("RESTING_HEART_RATE")).toBe(
      "metric:RESTING_HEART_RATE",
    );
    // The cache action appends `-status.<locale>`; the eviction sweep
    // matches on the `-status.` substring, so a generic scope is swept too.
    expect(
      `insights.${metricStatusScope("SLEEP_DURATION")}-status.de`,
    ).toContain("-status.");
  });

  it("maps STEPS / ACTIVE_ENERGY ids onto their divergent MeasurementType", () => {
    expect(getMetricStatusMeta("STEPS")?.measurementType).toBe(
      "ACTIVITY_STEPS",
    );
    expect(getMetricStatusMeta("ACTIVE_ENERGY")?.measurementType).toBe(
      "ACTIVE_ENERGY_BURNED",
    );
  });

  it("registers the v1.10.0 additive HealthKit signals with the expected direction", () => {
    const cases = [
      ["CARDIO_RECOVERY", "higher-better"],
      ["WRIST_TEMPERATURE", "target-band"],
      ["FALL_COUNT", "lower-better"],
      ["SIX_MINUTE_WALK_DISTANCE", "higher-better"],
      ["STAIR_ASCENT_SPEED", "higher-better"],
      ["STAIR_DESCENT_SPEED", "higher-better"],
      ["BREATHING_DISTURBANCES", "lower-better"],
    ] as const;
    for (const [id, direction] of cases) {
      const meta = getMetricStatusMeta(id);
      expect(meta, `${id} missing from registry`).not.toBeNull();
      expect(meta!.measurementType).toBe(id);
      expect(meta!.direction).toBe(direction);
      expect(METRIC_STATUS_IDS).toContain(id);
    }
  });

  it("anchors a six-minute-walk normal range from the population reference", () => {
    expect(
      getMetricStatusMeta("SIX_MINUTE_WALK_DISTANCE")?.normalRange,
    ).toEqual({ low: 400, high: 700 });
  });
});

describe("archetype prompt templates", () => {
  it("injects the metric metadata + normal range into the system prompt", () => {
    const meta = getMetricStatusMeta("OXYGEN_SATURATION")!;
    const sys = getMetricArchetypeSystemPrompt(meta, "en");
    expect(sys).toContain("Blood oxygen");
    expect(sys).toContain("95");
    expect(sys).toContain("PHYSIOLOGICAL VITAL");
  });

  it("uses the dedicated sleep archetype for SLEEP_DURATION", () => {
    const meta = getMetricStatusMeta("SLEEP_DURATION")!;
    const sys = getMetricArchetypeSystemPrompt(meta, "en");
    expect(sys).toContain("SLEEP");
    expect(
      getMetricArchetypeUserPrompt(meta, "{}", "2026-06-02", "en"),
    ).toContain("sleep duration");
  });
});

describe("generateMetricStatus — empty-data guard", () => {
  it("returns insufficient WITHOUT calling the provider when the metric has no data", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(0 as never);

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
      readOnly: true,
    });

    expect(result.insufficient).toBe(true);
    expect(result.text).toBeNull();
    expect(runStatusCompletion).not.toHaveBeenCalled();
    // No raw read either — the guard short-circuits before the gather.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });
});

describe("generateMetricStatus — generation path", () => {
  it("builds a graded snapshot, runs the archetype completion, and persists", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 400; day++) {
      records.push({
        value: 55 + (day % 6),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(400 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    const captured = { systemPrompt: null, userPrompt: null } as {
      systemPrompt: string | null;
      userPrompt: string | null;
    };
    stubCompletion(
      '{"summary":"Your resting heart rate is steady."}',
      captured,
    );

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Your resting heart rate is steady.");
    expect(result.cached).toBe(false);
    expect(result.hasProvider).toBe(true);

    // The snapshot embeds the graded series, not a raw daily array.
    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    expect(snapshot.RESTING_HEART_RATE.series).toHaveProperty("recent");
    expect(snapshot.metric.unit).toBe("bpm");

    // Persisted under the generic scope cache action.
    const createCall = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
      data: { action: string; details: string };
    };
    expect(createCall.data.action).toBe(
      "insights.metric:RESTING_HEART_RATE-status.en",
    );

    // v1.12.1 — the diversity context (variety lead + explicit data strength)
    // reaches the user prompt, and the relations fetch is keyed by this
    // metric's DB measurement type.
    expect(captured.userPrompt).toContain("VARIETY");
    expect(captured.userPrompt).toContain("DATA STRENGTH");
    expect(getRelevantCorrelationsForMetric).toHaveBeenCalledWith(
      "user-1",
      "RESTING_HEART_RATE",
      "en",
    );
  });

  it("weaves a returned correlation into the prompt as a descriptive relation", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 60; day++) {
      records.push({
        value: 60,
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(60 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);
    vi.mocked(getRelevantCorrelationsForMetric).mockResolvedValueOnce([
      {
        interpretation:
          "Higher time in daylight tends to go with lower next-day resting heart rate in your data — a pattern worth watching, not a cause.",
        n: 35,
        r: -0.46,
      },
    ]);

    const captured = { systemPrompt: null, userPrompt: null } as {
      systemPrompt: string | null;
      userPrompt: string | null;
    };
    stubCompletion('{"summary":"Steady RHR."}', captured);

    await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
    });

    expect(captured.userPrompt).toContain("RELATIONS");
    expect(captured.userPrompt).toContain(
      "Higher time in daylight tends to go with",
    );
    // Descriptive framing preserved verbatim — never recast as cause.
    expect(captured.userPrompt).toMatch(/NEVER causal/);
  });

  it("strips chart tokens from the persisted text", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 58, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    stubCompletion(
      '{"summary":"Steady. metric:RESTING_HEART_RATE Good baseline."}',
    );

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
    });

    expect(result.text).not.toContain("metric:");
    expect(result.text).toContain("Steady.");
  });
});
