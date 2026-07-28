import { describe, expect, it } from "vitest";

import { computeWeightGoal } from "../weight-goal";

const AS_OF = new Date("2026-07-28T12:00:00.000Z");
const target = { min: 74, max: 78 };

describe("personal weight-goal window", () => {
  it("ignores stale and future rows instead of presenting them as current", () => {
    const result = computeWeightGoal({
      rows: [
        {
          value: 80,
          at: new Date("2026-05-01T12:00:00.000Z"),
          source: "MANUAL",
        },
        {
          value: 76,
          at: new Date("2026-07-29T12:00:00.000Z"),
          source: "MANUAL",
        },
      ],
      target,
      source: "live",
      asOf: AS_OF,
    });

    expect(result.status).toBe("insufficient");
    expect(result.coverage.presentInputs).toBe(1);
    if (result.status === "insufficient") {
      expect(result.reason).toBe("weight_not_tracked");
    }
  });

  it("uses only in-window rows for the current value and comparison", () => {
    const result = computeWeightGoal({
      rows: [
        {
          value: 90,
          at: new Date("2026-05-01T12:00:00.000Z"),
          source: "MANUAL",
        },
        {
          value: 84,
          at: new Date("2026-07-10T12:00:00.000Z"),
          source: "MANUAL",
        },
        {
          value: 81,
          at: new Date("2026-07-27T12:00:00.000Z"),
          source: "MANUAL",
        },
        {
          value: 70,
          at: new Date("2026-07-29T12:00:00.000Z"),
          source: "MANUAL",
        },
      ],
      target,
      source: "live",
      asOf: AS_OF,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.currentKg).toBe(81);
      expect(result.value.distanceKg).toBe(3);
      expect(result.value.deltaKg).toBe(3);
      expect(result.provenance.windowDays).toBe(60);
    }
  });
});
