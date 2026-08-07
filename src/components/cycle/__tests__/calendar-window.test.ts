/**
 * The window arithmetic behind the month grid's own read.
 *
 * The bug it exists for is a save that appeared not to happen: the page read a
 * fixed ninety-days-back window, an April cell in August fell outside it, and
 * the write landed with nothing on screen to show for it. The month bounds and
 * the "is this month already covered" question are the whole of the decision,
 * so they are pinned here rather than left inside a component no test can drive.
 */
import { describe, it, expect } from "vitest";

import { monthBounds, monthOf, monthWindowOutside } from "../calendar-window";

describe("monthBounds", () => {
  it("spans a 30-day month", () => {
    expect(monthBounds("2026-04")).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("spans a 31-day month", () => {
    expect(monthBounds("2026-08")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("spans February in a common year and in a leap year", () => {
    expect(monthBounds("2026-02").to).toBe("2026-02-28");
    expect(monthBounds("2028-02").to).toBe("2028-02-29");
  });

  it("zero-pads so a day key compares as a date", () => {
    expect(monthBounds("2026-01")).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(monthBounds("2026-09").from < monthBounds("2026-10").from).toBe(
      true,
    );
  });
});

describe("monthWindowOutside", () => {
  // The page's anchored read on 2026-08-07: 90 days back, 180 forward.
  const anchor = { from: "2026-05-09", to: "2027-02-03" };

  it("reads nothing more for the month the anchor already carries", () => {
    expect(monthWindowOutside("2026-08", anchor)).toBeNull();
    expect(monthWindowOutside("2026-06", anchor)).toBeNull();
  });

  it("asks for the month the maintainer could not back-fill into", () => {
    expect(monthWindowOutside("2026-04", anchor)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("asks for a month that only overlaps the anchor's edge", () => {
    // May 2026 starts before 2026-05-09, so half of it is missing.
    expect(monthWindowOutside("2026-05", anchor)).toEqual({
      from: "2026-05-01",
      to: "2026-05-31",
    });
  });

  it("asks for a month past the forward edge too", () => {
    expect(monthWindowOutside("2027-03", anchor)).toEqual({
      from: "2027-03-01",
      to: "2027-03-31",
    });
  });

  it("stays a bounded read however far back the grid navigates", () => {
    // The anchor cannot simply be widened: the calendar route caps a span at
    // 400 days, and a union with a month two years back blows through it.
    const far = monthWindowOutside("2024-01", anchor);
    expect(far).toEqual({ from: "2024-01-01", to: "2024-01-31" });
    const span =
      (Date.parse(`${far!.to}T12:00:00Z`) -
        Date.parse(`${far!.from}T12:00:00Z`)) /
      86_400_000;
    expect(span).toBeLessThan(31);
  });
});

describe("monthOf", () => {
  it("takes the month a day key belongs to", () => {
    expect(monthOf("2026-04-18")).toBe("2026-04");
  });
});
