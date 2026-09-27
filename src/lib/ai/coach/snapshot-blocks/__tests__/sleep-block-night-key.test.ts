/**
 * v1.39.4 — the Coach names a night by the same key as the sleep table
 * under its answer: the local day the night ends on.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { buildSleepTimelineBlock } from "../sleep-block";

const TZ = "Pacific/Auckland";

describe("buildSleepTimelineBlock — night keys", () => {
  it("keys a night east of UTC by its local wake day, as the table does", () => {
    // Woke at 07:00 on 27 September in Auckland: still the 26th in UTC.
    const rows = [
      {
        value: 450,
        measuredAt: new Date("2026-09-26T19:00:00.000Z"),
        sleepStage: null,
        source: "APPLE_HEALTH" as const,
      },
    ];
    const snapshot: Record<string, unknown> = {};
    buildSleepTimelineBlock({
      sleepRows: rows,
      sourcePriorityJson: null,
      userTz: TZ,
      recentCutoff: new Date("2026-09-01T00:00:00.000Z"),
      snapshot,
      metrics: new Set(),
      counts: {},
      registerBlock: () => {},
      groundingValues: new Map(),
    });
    const recent = (
      snapshot.sleep as { timeline: { recent: Array<{ date: string }> } }
    ).timeline.recent;
    const tableKey = reconstructSleepNights(rows, TZ, null)[0].night;
    expect(tableKey).toBe("2026-09-27");
    expect(recent[0].date).toBe(tableKey);
  });
});
