/**
 * Which colour each reading earns, for every shape a reference window can
 * arrive in.
 *
 * The case worth spelling out is the inverted pair. A floor at or above its
 * ceiling is not a one-sided window, it is a window that cannot be true, and
 * the tempting reading — "well, we still have a minimum" — paints a high value
 * green. That is the wrong direction for a transcription error to fail in, so
 * it earns no verdict at all, matching what `lab-reference-range-bar.tsx` does
 * with the same input.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LabTrendSparkline } from "../lab-trend-sparkline";

const READINGS = [10, 50, 150];
const MUTED = [
  "fill-muted-foreground",
  "fill-muted-foreground",
  "fill-muted-foreground",
];

/** The fill class of each plotted reading, oldest → newest. */
function fills(
  referenceLow: number | null,
  referenceHigh: number | null,
): string[] {
  const markup = renderToStaticMarkup(
    <LabTrendSparkline
      values={READINGS}
      referenceLow={referenceLow}
      referenceHigh={referenceHigh}
    />,
  );
  // Each reading is a small rect, not a circle — this PR squares them off to
  // match the reference-range bar's marker.
  return Array.from(markup.matchAll(/<rect[^>]*class="([^"]*)"/gu)).map(
    (m) => m[1],
  );
}

describe("a reading's colour against its reference window", () => {
  it("judges against a real band", () => {
    expect(fills(30, 100)).toEqual([
      "fill-info",
      "fill-success",
      "fill-warning",
    ]);
  });

  it("judges a floor-only window", () => {
    expect(fills(30, null)).toEqual([
      "fill-info",
      "fill-success",
      "fill-success",
    ]);
  });

  it("judges a ceiling-only window", () => {
    expect(fills(null, 100)).toEqual([
      "fill-success",
      "fill-success",
      "fill-warning",
    ]);
  });

  it("gives no verdict without a window", () => {
    expect(fills(null, null)).toEqual(MUTED);
  });

  it("gives no verdict on an inverted pair rather than reading it as a floor", () => {
    // 100/30 — the same numbers as the valid band, transposed. Read as
    // "minimum 100" this would paint 150 green and 50 flagged.
    expect(fills(100, 30)).toEqual(MUTED);
  });

  it("gives no verdict when floor and ceiling are equal", () => {
    // A zero-width band cannot separate "inside" from "outside" either.
    expect(fills(50, 50)).toEqual(MUTED);
  });
});
