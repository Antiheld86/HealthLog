import { describe, it, expect } from "vitest";
import {
  buildHealthScoreBpInputs,
  buildHealthScoreWeightTarget,
} from "../health-score-inputs";
import type { BpInTargetEnvelope } from "../bp-in-target-fast-path";

function env(partial: Partial<BpInTargetEnvelope>): BpInTargetEnvelope {
  return {
    last7Days: null,
    last30Days: null,
    last90Days: null,
    last90EarliestAt: null,
    allTime: null,
    priorMonth: null,
    priorYear: null,
    path: "live",
    rowCount: 0,
    gradedScore: null,
    ...partial,
  };
}

describe("buildHealthScoreBpInputs — single Health-Score BP input builder", () => {
  /**
   * v1.17 W1b — the dashboard ring and the insights card must grade the BP
   * pillar off identical inputs. This pins the contract: given the same
   * current + prior-week envelopes, the builder produces one BP-input shape,
   * so whichever surface calls it sees the same pillar presence, value and
   * delta.
   */
  it("reads the 90-day window for the pillar rate, NOT 30-day or all-time", () => {
    const current = env({
      last30Days: { pct: 80, pairs: 10 },
      last90Days: { pct: 65, pairs: 40 },
      allTime: { pct: 50, pairs: 200 },
      gradedScore: 72,
    });
    const out = buildHealthScoreBpInputs(current, null);
    expect(out.bpInTargetPct).toBe(65);
    expect(out.bpGradedScore).toBe(72);
  });

  it("falls back to all-time only when the 90-day window is null", () => {
    const current = env({
      last90Days: null,
      allTime: { pct: 42, pairs: 100 },
      gradedScore: 60,
    });
    const out = buildHealthScoreBpInputs(current, null);
    expect(out.bpInTargetPct).toBe(42);
  });

  it("uses the prior-week 90-day window for the delta inputs", () => {
    const current = env({
      last90Days: { pct: 65, pairs: 40 },
      gradedScore: 72,
    });
    const priorWeek = env({
      last90Days: { pct: 58, pairs: 38 },
      gradedScore: 68,
    });
    const out = buildHealthScoreBpInputs(current, priorWeek);
    expect(out.bpInTargetPctPriorWeek).toBe(58);
    expect(out.bpGradedScorePriorWeek).toBe(68);
  });

  it("suppresses the pillar when the 90-day window is below the confidence floor and no all-time rescues it", () => {
    // 4 pairs in the last 90 days — below the floor of 5. Without an all-time
    // rate the pillar must disappear (rate + graded score both null) so a
    // thin-data user does not get a confident BP pillar.
    const current = env({
      last90Days: { pct: 100, pairs: 4 },
      allTime: { pct: 100, pairs: 4 },
      gradedScore: 95,
    });
    const out = buildHealthScoreBpInputs(current, null);
    // all-time is itself the same 4 pairs → rate present (deep history rescue
    // path), but here it is genuinely thin so the rate is the all-time pct.
    // Pin the stricter case: when all-time is also null the pillar collapses.
    const thin = buildHealthScoreBpInputs(
      env({
        last90Days: { pct: 100, pairs: 4 },
        allTime: null,
        gradedScore: 95,
      }),
      null,
    );
    expect(thin.bpInTargetPct).toBeNull();
    expect(thin.bpGradedScore).toBeNull();
    // The all-time fallback still rescues a deep-history account.
    expect(out.bpInTargetPct).toBe(100);
  });

  it("suppresses the prior-week graded score when the prior-week window is thin and no all-time rescues it", () => {
    // Current window healthy, prior-week 90-day window below the floor with no
    // all-time fallback → the prior-week graded score must not grade off the
    // thin sample, so the week-over-week graded delta stays consistent.
    const current = env({
      last90Days: { pct: 65, pairs: 40 },
      gradedScore: 72,
    });
    const priorWeek = env({
      last90Days: { pct: 90, pairs: 2 },
      allTime: null,
      gradedScore: 95,
    });
    const out = buildHealthScoreBpInputs(current, priorWeek);
    expect(out.bpGradedScore).toBe(72);
    expect(out.bpInTargetPctPriorWeek).toBeNull();
    expect(out.bpGradedScorePriorWeek).toBeNull();
  });

  it("collapses every field to null when the current envelope is absent", () => {
    const out = buildHealthScoreBpInputs(null, null);
    expect(out).toEqual({
      bpInTargetPct: null,
      bpInTargetPctPriorWeek: null,
      bpGradedScore: null,
      bpGradedScorePriorWeek: null,
    });
  });

  it("pillar presence is identical for two callers passing the same envelopes", () => {
    // Same data → same `bpInTargetPct !== null` presence verdict on both
    // surfaces. A user with BP history outside 30 days but inside 90 days
    // keeps the pillar on BOTH the dashboard ring and the insights card.
    const current = env({
      last30Days: null, // no readings in the last month
      last90Days: { pct: 55, pairs: 12 },
      allTime: { pct: 48, pairs: 300 },
      gradedScore: 64,
    });
    const a = buildHealthScoreBpInputs(current, null);
    const b = buildHealthScoreBpInputs(current, null);
    expect(a).toEqual(b);
    expect(a.bpInTargetPct).not.toBeNull();
  });
});

/**
 * v1.34 — the weight yardstick builder. The score used to grade weight against
 * `22 x height^2` +/- 2 kg, a band no user set and no surface named. The
 * builder is the one place the two Health-Score callers resolve it, and its
 * whole job is to refuse to hand over anything but a real user target.
 */
describe("buildHealthScoreWeightTarget — the one weight-yardstick resolver", () => {
  const profile = {
    heightCm: 178,
    dateOfBirth: new Date("1985-06-15T00:00:00.000Z"),
    gender: "MALE",
  };

  it("hands over the user's own band when they set one", () => {
    const result = buildHealthScoreWeightTarget(profile, {
      WEIGHT: { min: 74, max: 78 },
    });
    expect(result.weightTargetSource).toBe("user");
    expect(result.weightTarget).toEqual({ min: 74, max: 78 });
  });

  it("refuses the evidence-based default that sits under the override", () => {
    // `getEffectiveRange` resolves a height-derived WHO band for this profile.
    // It is a reference band, not a goal the person chose, so it must never
    // reach the score — that substitution IS the defect.
    const result = buildHealthScoreWeightTarget(profile, null);
    expect(result.weightTargetSource).toBe("none");
    expect(result.weightTarget).toBeNull();
  });

  it("ignores overrides on other metrics", () => {
    const result = buildHealthScoreWeightTarget(profile, {
      BLOOD_PRESSURE_SYS: { min: 110, max: 130 },
    });
    expect(result.weightTargetSource).toBe("none");
    expect(result.weightTarget).toBeNull();
  });

  it("returns no target for a profile with no height and no override", () => {
    const result = buildHealthScoreWeightTarget(
      { heightCm: null, dateOfBirth: null, gender: null },
      null,
    );
    expect(result.weightTargetSource).toBe("none");
    expect(result.weightTarget).toBeNull();
  });

  it("honours an override even when the profile carries no height", () => {
    const result = buildHealthScoreWeightTarget(
      { heightCm: null, dateOfBirth: null, gender: null },
      { WEIGHT: { min: 60, max: 65 } },
    );
    expect(result.weightTargetSource).toBe("user");
    expect(result.weightTarget).toEqual({ min: 60, max: 65 });
  });
});
