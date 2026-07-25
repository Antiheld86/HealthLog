/**
 * The export request contract.
 *
 * `.strict()` plus a required `selection` is the whole point: a body that says
 * nothing about scope is refused rather than resolved to a server default, and
 * the retired grouped `sections` shape is refused by name rather than folded
 * into one. Silently accepting a payload that does not express a scope is the
 * defect this release removes.
 *
 * Mutation checks:
 *   - make `selection` `.optional()` → "refuses a body that states no scope"
 *     goes red.
 *   - drop `.strict()` → "refuses the retired sections shape by name" and
 *     "rejects a userId smuggled into the body" go red.
 *   - re-add `includeAiSummary` to the schema → "refuses the retired AI summary
 *     flag" goes red.
 */
import { describe, it, expect } from "vitest";

import { exportSelectionSchema } from "../health-record-export";

const SELECTION = { v: 2, leaves: ["WEIGHT"] };

describe("exportSelectionSchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts each supported format", () => {
    for (const format of ["pdf", "fhir", "package"]) {
      expect(
        exportSelectionSchema.safeParse({ format, selection: SELECTION })
          .success,
      ).toBe(true);
    }
  });

  it("rejects an unknown format", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "xml",
      selection: SELECTION,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing format", () => {
    expect(
      exportSelectionSchema.safeParse({ selection: SELECTION }).success,
    ).toBe(false);
  });

  it("refuses a body that states no scope", () => {
    // An omitted selection is not "everything" and not "the defaults" — it is
    // a caller who did not say, and the route has nothing honest to serve.
    const parsed = exportSelectionSchema.safeParse({ format: "pdf" });
    expect(parsed.success).toBe(false);
  });

  it("accepts an explicitly empty scope", () => {
    // Saying "nothing" is a legitimate statement, distinct from saying nothing.
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: { v: 2, leaves: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a selection at the wrong version", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: { v: 1, leaves: ["WEIGHT"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses the retired sections shape by name", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      sections: { vitals: { bp: true } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("sections");
    }
  });

  it("refuses the retired AI summary flag", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      includeAiSummary: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown top-level keys (.strict)", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a userId smuggled into the body", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      userId: "someone-else",
    });
    expect(parsed.success).toBe(false);
  });

  it("enforces the range.days cap (1..365)", () => {
    expect(
      exportSelectionSchema.safeParse({
        format: "pdf",
        selection: SELECTION,
        range: { days: 365 },
      }).success,
    ).toBe(true);
    expect(
      exportSelectionSchema.safeParse({
        format: "pdf",
        selection: SELECTION,
        range: { days: 366 },
      }).success,
    ).toBe(false);
  });

  it("accepts an absolute custom window", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      range: {
        startDate: "2026-01-01T00:00:00+00:00",
        endDate: "2026-02-01T00:00:00+00:00",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("caps the practice name", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      selection: SELECTION,
      practiceName: "x".repeat(121),
    });
    expect(parsed.success).toBe(false);
  });
});
