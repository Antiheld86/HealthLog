import { describe, expect, it } from "vitest";

import {
  INVALID_SAMPLES_REASON,
  parseWorkoutBatch,
} from "@/lib/workouts/batch-ingest-parse";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
    source: "APPLE_HEALTH",
    externalId: "hk-uuid-1",
    ...overrides,
  };
}

describe("parseWorkoutBatch", () => {
  it("parses a clean batch and refuses nothing", () => {
    const result = parseWorkoutBatch({
      workouts: [
        entry({ samples: [{ t: "2026-05-14T06:30:00.000Z", hr: 120 }] }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refusedSampleIndices).toEqual([]);
    expect(result.data.workouts[0]?.samples).toHaveLength(1);
  });

  it("refuses only the entries whose samples array is malformed", () => {
    const result = parseWorkoutBatch({
      workouts: [
        entry({ externalId: "hk-a", samples: [{ t: "nope", hr: 4000 }] }),
        entry({ externalId: "hk-b" }),
        entry({ externalId: "hk-c", samples: [] }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refusedSampleIndices).toEqual([0, 2]);
    // The survivors keep their full typed shape.
    expect(result.data.workouts).toHaveLength(3);
    expect(result.data.workouts[1]?.externalId).toBe("hk-b");
    expect(result.data.workouts[0]?.samples).toBeUndefined();
  });

  it("keeps failing the whole batch when any other field is wrong", () => {
    const result = parseWorkoutBatch({
      workouts: [
        entry({ endedAt: "2026-05-14T06:00:00.000Z" }),
        entry({ externalId: "hk-b", samples: [{ t: "nope" }] }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/endedAt/i);
  });

  it("fails the batch when the envelope itself is not a batch", () => {
    expect(parseWorkoutBatch({ workouts: [] }).ok).toBe(false);
    expect(parseWorkoutBatch(null).ok).toBe(false);
    expect(parseWorkoutBatch({ workouts: "nope" }).ok).toBe(false);
  });

  it("names the per-entry reason code the route reports", () => {
    expect(INVALID_SAMPLES_REASON).toBe("invalid_samples");
  });
});
