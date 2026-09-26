/**
 * v1.22 (W6) — the daily-briefing personalization block: always an opener hint,
 * a sparse + hash-gated first-name clause, and byte-identical (name-free) output
 * for unnamed accounts.
 */
import { describe, expect, it } from "vitest";

import { buildBriefingPersonalisationBlock } from "../insight-generator";

const day = (iso: string) => new Date(iso);

describe("buildBriefingPersonalisationBlock", () => {
  it("always carries an opener hint", () => {
    const en = buildBriefingPersonalisationBlock(
      "user-1",
      null,
      "en",
      "UTC",
      day("2026-06-27T08:00:00Z"),
    );
    expect(en).toContain("OPENER HINT:");
    const de = buildBriefingPersonalisationBlock(
      "user-1",
      null,
      "de",
      "UTC",
      day("2026-06-27T08:00:00Z"),
    );
    expect(de).toContain("OPENER-HINWEIS:");
  });

  it("never emits a NAME clause when no display name is set", () => {
    for (let d = 1; d <= 28; d++) {
      const out = buildBriefingPersonalisationBlock(
        "user-1",
        null,
        "en",
        "UTC",
        day(`2026-06-${String(d).padStart(2, "0")}T08:00:00Z`),
      );
      expect(out).not.toContain("NAME:");
    }
  });

  it("surfaces the first name on SOME days but not every day (sparse)", () => {
    let withName = 0;
    let withoutName = 0;
    for (let d = 1; d <= 28; d++) {
      const out = buildBriefingPersonalisationBlock(
        "user-42",
        "Alex Rivera",
        "en",
        "UTC",
        day(`2026-06-${String(d).padStart(2, "0")}T08:00:00Z`),
      );
      if (out.includes('"Alex"')) withName += 1;
      else withoutName += 1;
    }
    // It appears on some days, and is NOT a rote daily greeting.
    expect(withName).toBeGreaterThan(0);
    expect(withoutName).toBeGreaterThan(0);
  });

  it("only ever uses the first name token, never the full display name", () => {
    const out = buildBriefingPersonalisationBlock(
      "user-42",
      "Alex Rivera",
      "en",
      "UTC",
      day("2026-06-30T08:00:00Z"),
    );
    expect(out).not.toContain("Rivera");
  });
});
