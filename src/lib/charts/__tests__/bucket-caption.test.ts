import { describe, expect, it } from "vitest";

import { bucketCaptionKey } from "../bucket-caption";

describe("bucketCaptionKey", () => {
  it("names a cumulative metric's folded point as a daily average", () => {
    expect(bucketCaptionKey("week", ["ACTIVITY_STEPS"])).toBe(
      "charts.bucketWeeklyDaily",
    );
    expect(bucketCaptionKey("month", ["ACTIVE_ENERGY_BURNED"])).toBe(
      "charts.bucketMonthlyDaily",
    );
  });

  it("keeps the plain average for a level", () => {
    expect(bucketCaptionKey("week", ["WEIGHT"])).toBe("charts.bucketWeekly");
    expect(
      bucketCaptionKey("month", ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]),
    ).toBe("charts.bucketMonthly");
  });

  it("says nothing for days", () => {
    expect(bucketCaptionKey("day", ["ACTIVITY_STEPS"])).toBeNull();
  });
});
