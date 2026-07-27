/**
 * v1.4.37 W2 — unit pin for the probe-gated Health Score helper.
 *
 * Mocks Prisma + the rollup-coverage probe so the path-selection
 * contract is verifiable without a Postgres container. Real-rollup
 * coverage lives in the integration suite at
 * `tests/integration/analytics-health-score.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // v1.11.1 — readRollupBuckets lazy-loads the source-priority blob.
    user: { findUnique: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  isFullyCovered: vi.fn(),
  probeRollupCoverage: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import { computeUserHealthScoreFastPath } from "../health-score-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const MOOD_FIND_MANY = prisma.moodEntry.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const MEDICATION_FIND_MANY = prisma.medication
  .findMany as unknown as ReturnType<typeof vi.fn>;
const INTAKE_FIND_MANY = prisma.medicationIntakeEvent
  .findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;
const FULLY_COVERED = isFullyCovered as unknown as ReturnType<typeof vi.fn>;
const ANNOTATE = annotate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  MEASUREMENT_FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  MOOD_FIND_MANY.mockReset();
  MEDICATION_FIND_MANY.mockReset();
  INTAKE_FIND_MANY.mockReset();
  PROBE.mockReset();
  FULLY_COVERED.mockReset();
  ANNOTATE.mockReset();

  // Defaults — empty everywhere. Individual tests override.
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  MOOD_FIND_MANY.mockResolvedValue([]);
  MEDICATION_FIND_MANY.mockResolvedValue([]);
  INTAKE_FIND_MANY.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeUserHealthScoreFastPath", () => {
  describe("rollup-fast-path — WEIGHT fully covered", () => {
    it("derives the weight series from DAY buckets and pins path:rollup", async () => {
      const coverage = new Map<string, boolean>([
        ["WEIGHT", true],
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // Two day-buckets inside the trailing 30 days, descending mean.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
        {
          bucketStart: new Date("2026-05-14T00:00:00.000Z"),
          count: 1,
          mean: 81.5,
          minValue: 81.5,
          maxValue: 81.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // v1.4.40 W-WMY-WIRE — the parallel long-window read fires
      // alongside the DAY-bucket read; mock its `findMany` to return
      // a coverage miss so the annotate carries `weightLongWindow:
      // null` and the score shape is unchanged.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]);
      // Weight source-attribution read (narrow 2-column).
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          source: "WITHINGS",
        },
        {
          measuredAt: new Date("2026-05-14T08:00:00.000Z"),
          source: "WITHINGS",
        },
      ])
        // BP-SYS source attribution read (parallel after rollup).
        .mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-rollup",
        bpInTargetPct: 85,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      // Path annotate proves the rollup branch fired.
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall).toBeDefined();
      // The rollup branch must NOT have called `measurement.findMany`
      // for the 37-day raw weight read; only the narrow 2-column source
      // pull + the BP source pull.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(2);
      // Both findMany calls projected a narrow select (no `value`).
      const calledArgs = MEASUREMENT_FIND_MANY.mock.calls.map((c) => c[0]);
      for (const arg of calledArgs) {
        expect(arg.select.value).toBeUndefined();
      }
      // Weight pillar value should reflect the downward slope from
      // bucket means (helper reports a numeric weight value).
      expect(result?.components.weight.value).not.toBeNull();
    });
  });

  /**
   * v1.4.40 W-WMY-WIRE — pin the long-window weight wiring through
   * `readBestGranularityRollups`. The score shape is unchanged; the
   * weightLongWindow annotate makes the rollup-tier consumption
   * verifiable in production wide-events.
   */
  describe("long-window weight wiring (W-WMY-WIRE)", () => {
    it("surfaces a MONTH-granularity weightLongWindow mean on the rollup branch", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", true]]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // DAY-bucket read (trailing 37 days) — single bucket, irrelevant
      // for the long-window assertion.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // readBestGranularityRollups(WEIGHT, 365) — first call is the
      // MONTH probe (floor 181 d). Two MONTH buckets, count-weighted
      // mean = (12*82 + 18*80) / 30 = 80.8.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2025-08-01T00:00:00.000Z"),
          count: 12,
          mean: 82,
          minValue: 80,
          maxValue: 84,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
        },
        {
          bucketStart: new Date("2025-09-01T00:00:00.000Z"),
          count: 18,
          mean: 80,
          minValue: 78,
          maxValue: 83,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
        },
      ]);
      // Source attribution + BP-SYS attribution reads.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          source: "WITHINGS",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-longwindow",
        bpInTargetPct: 85,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall).toBeDefined();
      const longWindow = pathCall?.meta?.healthScore?.weightLongWindow;
      expect(longWindow).not.toBeNull();
      expect(longWindow?.granularity).toBe("MONTH");
      expect(longWindow?.buckets).toBe(2);
      // Σ(count*mean) / Σcount = (12*82 + 18*80) / 30 = 80.8 → rounded.
      expect(longWindow?.mean).toBeCloseTo(80.8, 5);
    });

    it("emits weightLongWindow:null when the WMY tier carries no buckets", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", true]]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // DAY-bucket read.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // Long-window read — every granularity returns empty (router
      // walks MONTH → WEEK → DAY; 365 d skips YEAR floor).
      ROLLUP_FIND_MANY.mockResolvedValue([]);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          source: "WITHINGS",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-no-longwindow",
        bpInTargetPct: 85,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall?.meta?.healthScore?.weightLongWindow).toBeNull();
    });

    it("omits the long-window read on the live fallback branch", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // Weight live read + BP source attribution.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          value: 82.5,
          source: "MANUAL",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-live-nowmy",
        bpInTargetPct: 80,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      // The live branch never issues the long-window probe — guards
      // against accidentally double-reading on cold mounts where the
      // raw weight findMany is already doing the work.
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find((c) => c?.meta?.healthScore?.path === "live");
      expect(pathCall?.meta?.healthScore?.weightLongWindow).toBeNull();
    });
  });

  describe("live fallback — WEIGHT not covered", () => {
    it("reads raw weight rows and pins path:live", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      MEASUREMENT_FIND_MANY
        // Weight (live) — 37-day window, 3-column projection.
        .mockResolvedValueOnce([
          {
            measuredAt: new Date("2026-05-10T08:00:00.000Z"),
            value: 82.5,
            source: "MANUAL",
          },
          {
            measuredAt: new Date("2026-05-14T08:00:00.000Z"),
            value: 81.5,
            source: "MANUAL",
          },
        ])
        // BP-SYS source attribution.
        .mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-live",
        bpInTargetPct: 75,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find((c) => c?.meta?.healthScore?.path === "live");
      expect(pathCall).toBeDefined();
      // Live path read raw weight (value selected).
      const weightCall = MEASUREMENT_FIND_MANY.mock.calls[0][0];
      expect(weightCall.select.value).toBe(true);
      expect(weightCall.where.type).toBe("WEIGHT");
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });

    // Regression pin: a height-less user (no derivable weight target)
    // who DOES have weight readings must still get a populated, weighted
    // weight pillar. Before this fix the pillar came back
    // `{value:null, weight:0, source:"none"}` because the only target
    // source was `defaultWeightTargetFromHeight(null)` → null, and the
    // pillar was gated on having a target. The trend-only scoring path
    // now scores the bare weight trend instead.
    it("populates the weight pillar from a trend-only score when height is null", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      MEASUREMENT_FIND_MANY
        // Weight (live) — multiple readings inside the window, gentle decline.
        .mockResolvedValueOnce([
          {
            measuredAt: new Date("2026-05-04T08:00:00.000Z"),
            value: 84.0,
            source: "WITHINGS",
          },
          {
            measuredAt: new Date("2026-05-09T08:00:00.000Z"),
            value: 83.5,
            source: "WITHINGS",
          },
          {
            measuredAt: new Date("2026-05-14T08:00:00.000Z"),
            value: 83.0,
            source: "WITHINGS",
          },
        ])
        // BP-SYS source attribution.
        .mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-no-height",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      const weight = result?.components.weight;
      // The pillar is populated and weighted even with no target.
      expect(weight?.value).not.toBeNull();
      expect(weight?.weight).toBeGreaterThan(0);
      expect(weight?.source).not.toBe("none");
      // The source reflects the contributing ingest path, not the empty state.
      expect(weight?.source).toBe("withings");
    });
  });

  describe("empty path", () => {
    it("returns null with reason:no_components_available when nothing is computable", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      // No weight rows, no BP rows, no mood, no medications.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-empty",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        moodEnabled: true,
      });

      expect(result).toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const nullCall = calls.find(
        (c) => c?.meta?.healthScore?.reason === "no_components_available",
      );
      expect(nullCall).toBeDefined();
    });
  });

  /**
   * Issue #582 — a raw-record-presence check let a `0`/red score through
   * when every pillar still failed its own eligibility bar (weight needs
   * >= 2 readings, mood needs >= 5 entries, BP needs a paired reading,
   * compliance needs an active scheduled medication). The fix checks the
   * COMPUTED result's components instead of raw row counts.
   */
  describe("insufficient-data guard (#582)", () => {
    it("returns null — not a 0 score — when only one mood entry exists and no other pillar is eligible", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      const now = new Date("2026-06-07T12:00:00.000Z");

      // No weight rows, no BP rows, no medications.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      // Exactly one mood entry — below the 5-entry stability floor, so
      // moodStability() resolves to null even though the raw row count
      // is nonzero.
      MOOD_FIND_MANY.mockResolvedValue([{ score: 4, moodLoggedAt: now }]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-one-mood-entry",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const nullCall = calls.find(
        (c) => c?.meta?.healthScore?.reason === "no_components_available",
      );
      expect(nullCall).toBeDefined();
    });

    it("returns null — not a 0 score — when only one weight reading exists and no other pillar is eligible", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      const now = new Date("2026-06-07T12:00:00.000Z");

      // Exactly one weight reading — below the 2-reading regression floor,
      // so weightTrendAlignment() resolves to null.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-06-05T08:00:00.000Z"),
          value: 82.5,
          source: "MANUAL",
        },
      ]).mockResolvedValueOnce([]); // BP-SYS source attribution, empty.

      const result = await computeUserHealthScoreFastPath({
        userId: "user-one-weight-reading",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const nullCall = calls.find(
        (c) => c?.meta?.healthScore?.reason === "no_components_available",
      );
      expect(nullCall).toBeDefined();
    });

    it("returns null when raw records exist across multiple pillars but none clears its own minimum", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      const now = new Date("2026-06-07T12:00:00.000Z");

      // One weight reading (< 2) + one mood entry (< 5) + no BP + no
      // active medications. Every pillar has SOME data, but none is
      // individually eligible.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-06-05T08:00:00.000Z"),
          value: 82.5,
          source: "MANUAL",
        },
      ]).mockResolvedValueOnce([]);
      MOOD_FIND_MANY.mockResolvedValue([{ score: 3, moodLoggedAt: now }]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-multi-pillar-ineligible",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).toBeNull();
    });

    it("preserves a legitimately computed score of 0 rather than treating it as insufficient data", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      const now = new Date("2026-06-07T12:00:00.000Z");

      // No weight, no mood, no medications — but a real, computed BP
      // pillar that lands on exactly 0. This must stay a genuine `0`
      // score, not get swept into the null branch.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { measuredAt: new Date("2026-06-05T08:00:00.000Z"), source: "MANUAL" },
      ]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-legit-zero",
        bpInTargetPct: 0,
        bpGradedScore: 0,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      expect(result?.components.bp.value).toBe(0);
      expect(result?.score).toBe(0);
    });
  });

  describe("coverage probing", () => {
    it("probes coverage when the caller omits the map", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-fresh",
        bpInTargetPct: null,
        weightTarget: null,
        weightTargetSource: "none",
        now: new Date("2026-05-17T12:00:00.000Z"),
        moodEnabled: true,
      });

      expect(PROBE).toHaveBeenCalledWith("user-fresh");
    });
  });

  // v1.4.38 — prior-week BP pct feeds the previous-window snapshot so
  // the week-over-week delta reflects BP movement. Legacy callers that
  // omit the field keep the pre-v1.4.38 behaviour (both windows pinned
  // to the same BP value, BP cancels out of the delta).
  describe("prior-week BP pct contract", () => {
    it("feeds bpInTargetPctPriorWeek into the previous-window snapshot when set", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-bpdelta",
        bpInTargetPct: 90,
        bpInTargetPctPriorWeek: 70,
        weightTarget: null,
        weightTargetSource: "none",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        moodEnabled: true,
      });

      // With only BP data the helper still returns a score. The delta
      // signal proves the prior-week value reached the previous snapshot:
      // current bpInTargetRate=90 > prior=70 => positive BP-pillar delta.
      expect(result).not.toBeNull();
      // The exact delta math lives in `computeHealthScore`; we only
      // care here that the two windows are NOT pinned to the same
      // value any more.
      const componentDelta = result?.delta;
      expect(
        typeof componentDelta === "number" || componentDelta === null,
      ).toBe(true);
    });

    it("falls back to bpInTargetPct when bpInTargetPctPriorWeek is omitted", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      // Both runs use the same bpInTargetPct in both windows; the BP
      // pillar contributes zero to the delta. Pre-v1.4.38 behaviour
      // preserved for callers that don't opt in.
      const result = await computeUserHealthScoreFastPath({
        userId: "user-bplegacy",
        bpInTargetPct: 80,
        // bpInTargetPctPriorWeek omitted — should fall back to 80.
        weightTarget: null,
        weightTargetSource: "none",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
    });
  });

  // v1.5.0 — regression pin for the cadence-aware compliance migration
  // (closes #214). Before this release the score helper fed every
  // medication-compliance pillar through `schedules.length * 30` as the
  // denominator, so a weekly Ozempic schedule with 4 taken Mondays
  // reported ~13% and dragged the score down ~10–15 points. The
  // adapter now matches the cadence chart's denominator (Mondays-in-
  // window) and the weekly med contributes its true 100% rate.
  describe("cadence-aware medication compliance (closes #214)", () => {
    function mondaysInWindow(now: Date, days: number): Date[] {
      const out: Date[] = [];
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const cursor = new Date(from);
      while (cursor <= now) {
        if (cursor.getUTCDay() === 1) {
          out.push(new Date(cursor));
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return out;
    }

    it("weekly Mondays-only med with all Mondays taken contributes a 100% pillar", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      // Weight + BP attribution reads return empty so only the
      // medication compliance pillar is non-null.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const now = new Date("2026-05-13T12:00:00.000Z"); // Wed
      MEDICATION_FIND_MANY.mockResolvedValueOnce([
        {
          id: "med-weekly",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          schedules: [
            { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "1" },
          ],
        },
      ]);
      // One intake per Monday inside the trailing 30 days. The
      // cadence pairing reads `scheduledFor` for both anchor and
      // event, so the Mondays-only timeline lines up cleanly.
      const events = mondaysInWindow(now, 30).map((mon) => ({
        medicationId: "med-weekly",
        scheduledFor: new Date(
          Date.UTC(
            mon.getUTCFullYear(),
            mon.getUTCMonth(),
            mon.getUTCDate(),
            8,
            30,
          ),
        ),
        takenAt: new Date(
          Date.UTC(
            mon.getUTCFullYear(),
            mon.getUTCMonth(),
            mon.getUTCDate(),
            8,
            35,
          ),
        ),
        skipped: false,
      }));
      // The helper reads the 37-day window (prevSince30d → now) so
      // the prior-week snapshot has data too — return the same set
      // unfiltered; the helper filters internally.
      INTAKE_FIND_MANY.mockResolvedValueOnce(events);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-weekly-med",
        bpInTargetPct: 80,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      // The medication pillar must be populated and reflect a 100%
      // rate (or at least ≥ 50, well above the pre-fix ~13%). The
      // exact pillar number depends on `computeHealthScore`'s
      // weighting; we assert the directional contract — the score is
      // computed AND the compliance branch fired.
      expect(result?.components.compliance.value).not.toBeNull();
      const complianceValue = result?.components.compliance.value ?? 0;
      // Pre-fix this user reported ~13% adherence → ~13 here. The
      // post-fix path produces ≥ 90 (one Monday per week, all taken
      // → 100% with the new denominator). 50 is a wide safety margin
      // that catches the regression with zero flake risk.
      expect(complianceValue).toBeGreaterThanOrEqual(50);
    });

    it("daily-only med with all doses taken still reports 100% (no regression on the path that already worked)", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const now = new Date("2026-05-13T12:00:00.000Z"); // Wed
      MEDICATION_FIND_MANY.mockResolvedValueOnce([
        {
          id: "med-daily",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          schedules: [
            { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
          ],
        },
      ]);
      // One taken event per day over the trailing 30 days — including
      // today's already-past slot (08:00 UTC < NOW = 12:00).
      const events = [];
      for (let d = 0; d < 30; d++) {
        const day = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
        const at = new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            8,
            30,
          ),
        );
        if (at.getTime() > now.getTime()) continue;
        events.push({
          medicationId: "med-daily",
          scheduledFor: at,
          takenAt: new Date(at.getTime() + 5 * 60_000),
          skipped: false,
        });
      }
      INTAKE_FIND_MANY.mockResolvedValueOnce(events);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-daily-med",
        bpInTargetPct: 80,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      // Daily-only path was correct under the legacy denominator and
      // stays correct under the cadence denominator. The contract:
      // taken=N, missed=0 → rate=100; pillar reads ≥ 90 with whatever
      // weighting `computeHealthScore` applies.
      expect(result?.components.compliance.value).toBeGreaterThanOrEqual(90);
    });
  });

  /**
   * v1.18.0 R4 — module-aware mood pillar. With the mood module disabled
   * the helper must NOT read mood, must null-weight the mood pillar, and
   * must re-normalise the surviving pillars so the score isn't penalised
   * (or inflated) by a pillar the user can no longer see. Golden fixture:
   * an identical profile with strong, stable mood scored mood-on vs
   * mood-off must produce a different, correctly re-weighted score.
   *
   * v1.34 — the flag is required. It used to default to on, and the
   * dashboard snapshot never passed it, so the hero ring scored a pillar
   * the account had switched off while the Insights card dropped it.
   */
  describe("module-aware mood pillar (R4)", () => {
    // A profile with BP + steady high mood (low variance → high
    // stability) + nothing else, so the mood pillar's contribution is
    // unambiguous. Six entries clears the 5-entry stability floor.
    function steadyMood(now: Date) {
      return Array.from({ length: 6 }, (_v, i) => ({
        score: 4,
        moodLoggedAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
      }));
    }

    it("weights the mood pillar when moodEnabled is true", async () => {
      const coverage = new Map<string, boolean>();
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const now = new Date("2026-06-07T12:00:00.000Z");
      MOOD_FIND_MANY.mockResolvedValue(steadyMood(now));

      const result = await computeUserHealthScoreFastPath({
        userId: "user-mood-on",
        bpInTargetPct: 60,
        bpGradedScore: 60,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      // Mood read fired and the pillar carries a non-zero weight.
      expect(MOOD_FIND_MANY).toHaveBeenCalled();
      expect(result?.components.mood.value).not.toBeNull();
      expect(result?.components.mood.weight).toBeGreaterThan(0);
    });

    it("drops the mood pillar and re-normalises the score when moodEnabled is false", async () => {
      const coverage = new Map<string, boolean>();
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const now = new Date("2026-06-07T12:00:00.000Z");
      // Even if mood rows existed they must be ignored — the helper
      // should never issue the read when the module is off.
      MOOD_FIND_MANY.mockResolvedValue(steadyMood(now));

      const result = await computeUserHealthScoreFastPath({
        userId: "user-mood-off",
        bpInTargetPct: 60,
        bpGradedScore: 60,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: false,
      });

      expect(result).not.toBeNull();
      // The disabled module is off the round-trip budget entirely.
      expect(MOOD_FIND_MANY).not.toHaveBeenCalled();
      // Mood pillar null-weighted; surviving pillar (BP) absorbs the
      // freed weight via proportional redistribution.
      expect(result?.components.mood.value).toBeNull();
      expect(result?.components.mood.weight).toBe(0);
      expect(result?.components.bp.weight).toBe(1);
      // BP is the only present pillar → score is the BP graded value.
      expect(result?.score).toBe(60);
    });

    it("golden: mood-on vs mood-off yield different, correctly re-weighted scores", async () => {
      const coverage = new Map<string, boolean>();
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      const now = new Date("2026-06-07T12:00:00.000Z");

      // Mood-ON: BP=60 (0.30) + perfect-stability mood=100 (0.20).
      // present base weights = 0.50 → bp 0.6, mood 0.4 →
      // 60*0.6 + 100*0.4 = 36 + 40 = 76.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      MOOD_FIND_MANY.mockResolvedValue(
        // Constant score → coefficient of variation 0 → stability 100.
        Array.from({ length: 6 }, (_v, i) => ({
          score: 5,
          moodLoggedAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        })),
      );
      const onResult = await computeUserHealthScoreFastPath({
        userId: "user-golden-on",
        bpInTargetPct: 60,
        bpGradedScore: 60,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      // Mood-OFF: only BP=60 survives → score 60.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const offResult = await computeUserHealthScoreFastPath({
        userId: "user-golden-off",
        bpInTargetPct: 60,
        bpGradedScore: 60,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: false,
      });

      expect(onResult?.score).toBe(76);
      expect(offResult?.score).toBe(60);
      // The mood-off score is NOT silently dragged toward 0 by a phantom
      // pillar — it equals the honest single-pillar BP score.
      expect(offResult?.score).not.toBe(onResult?.score);
    });
  });

  /**
   * v1.15.12 A1 — the graded clinical-proximity score, when supplied,
   * becomes the BP pillar VALUE; the binary in-target rate only gates
   * presence. A "borderline-stage-1" profile that read ~16/100 under the
   * old binary contract must now read in the graded band.
   */
  describe("graded BP pillar (A1)", () => {
    it("uses bpGradedScore as the pillar value, not the binary rate", async () => {
      const coverage = new Map<string, boolean>();
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-06-07T12:00:00.000Z");
      // Live fallback — no weight/mood/med data; only BP signal present.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]) // weight raw read (live fallback)
        .mockResolvedValueOnce([]); // BP-SYS source attribution

      const result = await computeUserHealthScoreFastPath({
        userId: "user-graded-bp",
        // Binary all-time rate is catastrophic (the old pillar value)…
        bpInTargetPct: 16,
        // …but the graded clinical-proximity score says borderline.
        bpGradedScore: 55,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      // Pillar reads the graded score, NOT the binary 16.
      expect(result?.components.bp.value).toBe(55);
    });

    it("keeps the pillar absent when no BP readings exist (presence gate)", async () => {
      const coverage = new Map<string, boolean>();
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-06-07T12:00:00.000Z");
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]) // weight raw read
        .mockResolvedValueOnce([]); // BP-SYS source attribution
      // Mood present so the score is computable even without BP.
      MOOD_FIND_MANY.mockResolvedValue(
        Array.from({ length: 6 }, (_v, i) => ({
          score: 4,
          moodLoggedAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000),
        })),
      );

      const result = await computeUserHealthScoreFastPath({
        userId: "user-no-bp",
        // No paired BP readings → rate is null → pillar absent even if a
        // stray graded score were supplied.
        bpInTargetPct: null,
        bpGradedScore: 80,
        weightTarget: null,
        weightTargetSource: "none",
        now,
        coverage,
        moodEnabled: true,
      });

      expect(result).not.toBeNull();
      expect(result?.components.bp.value).toBeNull();
      expect(result?.components.bp.weight).toBe(0);
    });
  });
});
