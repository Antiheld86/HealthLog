/**
 * v1.32.30 — the height entry adapter.
 *
 * Two properties carry the whole feature and both are swept, not
 * sampled:
 *
 *   1. Round-trip stability. Every feet + inches pair the imperial
 *      fields can offer must survive save-then-reopen unchanged, or a
 *      user's height creeps by a fraction on every visit to Settings.
 *   2. Inward-rounded bounds. Every value inside the client's own
 *      limits must invert to a centimetre value the server's 50-300
 *      Zod bound accepts, or an imperial user is handed a field that
 *      422s.
 *
 * The metric branch is asserted with `toBe` (identity, no rounding
 * drift), because "we quietly re-derived every metric account's stored
 * height" is the expensive way to get this wrong.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_HEIGHT_DRAFT,
  resolveHeightUnitAdapter,
} from "@/lib/profile/height-unit-display";

/** The canonical window `src/lib/validations/auth.ts` enforces. */
const MIN_CM = 50;
const MAX_CM = 300;

const metric = resolveHeightUnitAdapter("metric");
const imperial = resolveHeightUnitAdapter("imperial");

describe("height unit adapter — metric branch", () => {
  it("renders a single centimetres field, not the feet + inches pair", () => {
    expect(metric.usesFeetInches).toBe(false);
    expect(metric.preference).toBe("metric");
  });

  it("seeds the draft as the exact stored number, unrounded", () => {
    for (const cm of [50, 160, 175.5, 180, 180.34, 199.99, 300]) {
      expect(metric.toDraft(cm)).toEqual({
        cm: String(cm),
        feet: "",
        inches: "",
      });
    }
  });

  it("returns the typed centimetres untouched (identity, no drift)", () => {
    for (const typed of ["50", "160", "175.5", "180", "180.34", "300"]) {
      expect(metric.toCanonicalCm({ ...EMPTY_HEIGHT_DRAFT, cm: typed })).toBe(
        Number.parseFloat(typed),
      );
    }
  });

  it("round-trips every stored centimetre value byte-for-byte", () => {
    for (let cm = MIN_CM; cm <= MAX_CM; cm += 0.5) {
      expect(metric.toCanonicalCm(metric.toDraft(cm))).toBe(cm);
    }
  });

  it("reads a blank or unparseable field as no height", () => {
    expect(metric.toCanonicalCm(EMPTY_HEIGHT_DRAFT)).toBeNull();
    expect(
      metric.toCanonicalCm({ cm: "   ", feet: "", inches: "" }),
    ).toBeNull();
    expect(
      metric.toCanonicalCm({ cm: "abc", feet: "", inches: "" }),
    ).toBeNull();
    expect(metric.toDraft(null)).toEqual(EMPTY_HEIGHT_DRAFT);
    expect(metric.toDraft(undefined)).toEqual(EMPTY_HEIGHT_DRAFT);
  });

  it("offers the canonical guardrails unconverted", () => {
    expect(metric.bounds.cm).toEqual({ min: MIN_CM, max: MAX_CM });
  });
});

describe("height unit adapter — imperial branch", () => {
  it("renders the two-part feet + inches row", () => {
    expect(imperial.usesFeetInches).toBe(true);
    expect(imperial.preference).toBe("imperial");
  });

  it("converts the worked example both ways", () => {
    const cm = imperial.toCanonicalCm({ cm: "", feet: "5", inches: "11" });
    expect(cm).toBe(180.34);
    expect(imperial.toDraft(cm)).toEqual({ cm: "", feet: "5", inches: "11" });
  });

  it("round-trips EVERY feet + inches pair the fields can offer", () => {
    const { feet, inches } = imperial.bounds;
    let checked = 0;
    for (let ft = feet.min; ft <= feet.max; ft += 1) {
      for (let inch = inches.min; inch <= inches.max; inch += 1) {
        const draft = { cm: "", feet: String(ft), inches: String(inch) };
        const cm = imperial.toCanonicalCm(draft);
        expect(cm).not.toBeNull();
        expect(imperial.toDraft(cm)).toEqual(draft);
        checked += 1;
      }
    }
    // A silently empty sweep is a green void.
    expect(checked).toBeGreaterThan(60);
  });

  it("round-trips every whole-inch height across the plausible range", () => {
    // Independent of the offered rectangle: the full canonical window
    // expressed in whole inches, which is what a height synced from a
    // wearable can land on.
    for (let totalInches = 20; totalInches <= 118; totalInches += 1) {
      const draft = {
        cm: "",
        feet: String(Math.floor(totalInches / 12)),
        inches: String(totalInches % 12),
      };
      const cm = imperial.toCanonicalCm(draft);
      expect(cm).not.toBeNull();
      expect(cm).toBeGreaterThanOrEqual(MIN_CM);
      expect(cm).toBeLessThanOrEqual(MAX_CM);
      expect(imperial.toDraft(cm)).toEqual(draft);
    }
  });

  it("keeps every value inside the offered limits acceptable to the server", () => {
    const { feet, inches } = imperial.bounds;
    const corners = [
      { feet: feet.min, inches: inches.min },
      { feet: feet.min, inches: inches.max },
      { feet: feet.max, inches: inches.min },
      { feet: feet.max, inches: inches.max },
    ];
    for (const corner of corners) {
      const cm = imperial.toCanonicalCm({
        cm: "",
        feet: String(corner.feet),
        inches: String(corner.inches),
      });
      expect(cm).not.toBeNull();
      expect(cm).toBeGreaterThanOrEqual(MIN_CM);
      expect(cm).toBeLessThanOrEqual(MAX_CM);
    }
  });

  it("rounds the offered window INWARD, never outward", () => {
    // The naive rounding: 300 cm is 118.11 in, so a feet ceiling of 9
    // would let 9 ft 11 in (119 in = 302.26 cm) through the client and
    // straight into a server 422.
    const { feet, inches } = imperial.bounds;
    expect(inches).toEqual({ min: 0, max: 11 });
    const justOverTheCeiling = imperial.toCanonicalCm({
      cm: "",
      feet: String(feet.max + 1),
      inches: "11",
    });
    expect(justOverTheCeiling).toBeGreaterThan(MAX_CM);
  });

  it("rejects a genuinely out-of-range height as out of range", () => {
    const tooTall = imperial.toCanonicalCm({
      cm: "",
      feet: "12",
      inches: "0",
    });
    expect(tooTall).toBe(365.76);
    expect(tooTall).toBeGreaterThan(MAX_CM);
    const tooShort = imperial.toCanonicalCm({ cm: "", feet: "1", inches: "0" });
    expect(tooShort).toBeLessThan(MIN_CM);
  });

  it("treats an untouched inches box as zero, not as no height", () => {
    expect(imperial.toCanonicalCm({ cm: "", feet: "6", inches: "" })).toBe(
      182.88,
    );
    expect(imperial.toCanonicalCm({ cm: "", feet: "", inches: "8" })).toBe(
      20.32,
    );
  });

  it("reads a blank or unparseable pair as no height", () => {
    expect(imperial.toCanonicalCm(EMPTY_HEIGHT_DRAFT)).toBeNull();
    expect(
      imperial.toCanonicalCm({ cm: "", feet: "  ", inches: "  " }),
    ).toBeNull();
    expect(
      imperial.toCanonicalCm({ cm: "", feet: "abc", inches: "3" }),
    ).toBeNull();
    expect(imperial.toDraft(null)).toEqual(EMPTY_HEIGHT_DRAFT);
  });

  it("quantises a fractional inch so the round-trip still holds", () => {
    const cm = imperial.toCanonicalCm({ cm: "", feet: "5", inches: "11.5" });
    expect(cm).toBe(182.88); // 72 in
    expect(imperial.toDraft(cm)).toEqual({ cm: "", feet: "6", inches: "0" });
    expect(imperial.toCanonicalCm(imperial.toDraft(cm))).toBe(cm);
  });

  it("snaps a centimetre-entered height to the nearest whole inch", () => {
    // A metric account that flips to imperial: 180 cm reads as 5 ft 11
    // in, and the next save re-canonicalises to 180.34. One snap, then
    // stable forever.
    expect(imperial.toDraft(180)).toEqual({ cm: "", feet: "5", inches: "11" });
    const resaved = imperial.toCanonicalCm(imperial.toDraft(180));
    expect(resaved).toBe(180.34);
    expect(imperial.toDraft(resaved)).toEqual({
      cm: "",
      feet: "5",
      inches: "11",
    });
  });
});

describe("height unit adapter — resolution", () => {
  it("falls back to the metric branch for anything but imperial", () => {
    expect(resolveHeightUnitAdapter("metric")).toBe(metric);
    expect(resolveHeightUnitAdapter("imperial")).toBe(imperial);
  });
});
