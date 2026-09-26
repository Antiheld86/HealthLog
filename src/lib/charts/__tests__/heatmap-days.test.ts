import { describe, expect, it } from "vitest";

import { heatmapDays } from "../heatmap-days";

describe("heatmapDays", () => {
  it.each([
    // 20:30 in New York is already the next UTC day.
    ["America/New_York", "2026-03-09T00:30:00.000Z", "2026-03-08"],
    // 08:00 in Auckland and Tonga is still the previous UTC day.
    ["Pacific/Auckland", "2026-04-04T20:00:00.000Z", "2026-04-05"],
    ["Pacific/Tongatapu", "2026-07-27T19:00:00.000Z", "2026-07-28"],
    ["America/Santiago", "2026-09-06T03:30:00.000Z", "2026-09-05"],
    ["Europe/Berlin", "2026-10-25T22:30:00.000Z", "2026-10-25"],
  ])("ends on today's key in %s", (tz, iso, today) => {
    const days = heatmapDays(new Date(iso), tz, 14);
    expect(days).toHaveLength(14);
    expect(days.at(-1)?.dateKey).toBe(today);
    // Consecutive keys, one per day, no gap or repeat across DST.
    for (let i = 1; i < days.length; i++) {
      const prev = Date.parse(`${days[i - 1].dateKey}T00:00:00Z`);
      const cur = Date.parse(`${days[i].dateKey}T00:00:00Z`);
      expect(cur - prev).toBe(86_400_000);
    }
  });

  it("reads weekday and month off the key", () => {
    const [last] = heatmapDays(
      new Date("2026-03-01T03:00:00.000Z"),
      "America/New_York",
      1,
    );
    // 22:00 on Saturday 28 February in New York.
    expect(last).toEqual({ dateKey: "2026-02-28", dow: 5, month: 1 });
  });
});
