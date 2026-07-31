/**
 * RECON1 (D5-5) — the no-tools snapshot driver block surfaces the SAME gated,
 * ranked drivers the get_correlations tool serves, bounded to the top N, and
 * attaches nothing when no driver survives the quality gates.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const readCoachCorrelations = vi.fn();
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: (userId: string) => readCoachCorrelations(userId),
}));

import {
  buildCorrelationsSnapshotBlock,
  SNAPSHOT_DRIVER_CAP,
} from "@/lib/ai/coach/correlations-snapshot";
import type { CoachCorrelationDriver } from "@/lib/ai/coach/tools/correlations-read";

function driver(
  behaviour: string,
  outcome: string,
  r: number,
): CoachCorrelationDriver {
  return {
    behaviour,
    outcome,
    direction: r >= 0 ? "higher" : "lower",
    lagDays: 1,
    n: 42,
    r,
    note: `Higher ${behaviour} tends to go with ${outcome} — not a cause.`,
  };
}

describe("buildCorrelationsSnapshotBlock (D5-5)", () => {
  beforeEach(() => {
    readCoachCorrelations.mockReset();
  });

  it("carries driver pairs when the engine surfaces them", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: true,
      drivers: [
        driver("time in daylight", "sleep duration", 0.41),
        driver("mood", "resting heart rate", -0.33),
      ],
      pairsTested: 16,
      windowDays: 180,
    });
    const block = await buildCorrelationsSnapshotBlock("user-1", "en");
    expect(block).not.toBeNull();
    expect(block!.drivers).toHaveLength(2);
    expect(block!.drivers[0].behaviour).toBe("time in daylight");
    expect(block!.pairsTested).toBe(16);
    expect(block!.windowDays).toBe(180);
  });

  it("bounds the block to the top N ranked drivers", async () => {
    const many = Array.from({ length: SNAPSHOT_DRIVER_CAP + 4 }, (_, i) =>
      driver(`behaviour ${i}`, "sleep duration", 0.5 - i * 0.02),
    );
    readCoachCorrelations.mockResolvedValue({
      present: true,
      drivers: many,
      pairsTested: 30,
      windowDays: 180,
    });
    const block = await buildCorrelationsSnapshotBlock("user-1", "en");
    expect(block!.drivers).toHaveLength(SNAPSHOT_DRIVER_CAP);
    // Order preserved from the already-ranked tool output (highest effect first).
    expect(block!.drivers[0].behaviour).toBe("behaviour 0");
  });

  it("attaches nothing when no driver survives the quality gates", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: false,
      reason: "no_significant_pattern",
    });
    expect(await buildCorrelationsSnapshotBlock("user-1", "en")).toBeNull();
  });

  it("attaches nothing when present but the driver list is empty (coincident-only)", async () => {
    // The reader can be present purely for the coincident flag with zero
    // discovered drivers — the snapshot floor adds the driver layer only.
    readCoachCorrelations.mockResolvedValue({
      present: true,
      drivers: [],
      coincident: { fired: true, contributing: [], day: "2026-06-26" },
      pairsTested: 12,
      windowDays: 180,
    });
    expect(await buildCorrelationsSnapshotBlock("user-1", "en")).toBeNull();
  });
});
