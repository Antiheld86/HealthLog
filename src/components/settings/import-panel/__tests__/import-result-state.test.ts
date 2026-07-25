/**
 * #640 — an import that wrote nothing must never read as a success.
 *
 * The reported failure was not the parser refusing rows; it was the card
 * answering that refusal with a green tick, which is what turned a
 * recoverable problem into a silent one. These pin the classifier that both
 * import cards render from, and the structural guard that keeps the success
 * affordance attached to the success outcome alone lives alongside in
 * `import-result-guard.test.ts`.
 */
import { describe, it, expect } from "vitest";

import {
  classifyImportOutcome,
  groupSkipReasons,
} from "../import-result-state";

describe("classifyImportOutcome", () => {
  it("calls the reported production result a failure", () => {
    // The audit envelope from the report: 1 597 rows in, nothing written.
    expect(classifyImportOutcome({ written: 0, skipped: 1597 })).toBe("failed");
  });

  it("calls a file with no data rows empty, not a success", () => {
    expect(classifyImportOutcome({ written: 0, skipped: 0 })).toBe("empty");
  });

  it("calls a mixed result partial", () => {
    expect(classifyImportOutcome({ written: 3, skipped: 2 })).toBe("partial");
  });

  it("calls a clean result a success", () => {
    expect(classifyImportOutcome({ written: 5, skipped: 0 })).toBe("success");
  });

  it("never reaches success while nothing was written", () => {
    for (let written = 0; written <= 4; written++) {
      for (let skipped = 0; skipped <= 4; skipped++) {
        const outcome = classifyImportOutcome({ written, skipped });
        if (written === 0) {
          expect(outcome).not.toBe("success");
          expect(outcome).not.toBe("partial");
        }
        if (outcome === "success") {
          expect(written).toBeGreaterThan(0);
          expect(skipped).toBe(0);
        }
      }
    }
  });
});

describe("groupSkipReasons", () => {
  it("collapses a repeated reason to one entry with a count", () => {
    const rows = Array.from({ length: 1597 }, (_, i) => ({
      line: i + 2,
      status: "skipped",
      reason: "invalid_glucose_context",
    }));
    expect(groupSkipReasons(rows)).toEqual([
      { reason: "invalid_glucose_context", count: 1597 },
    ]);
  });

  it("ignores rows that were written", () => {
    expect(
      groupSkipReasons([
        { line: 2, status: "inserted" },
        { line: 3, status: "updated" },
        { line: 4, status: "skipped", reason: "unknown_unit" },
      ]),
    ).toEqual([{ reason: "unknown_unit", count: 1 }]);
  });

  it("orders by count descending, then by reason", () => {
    const rows = [
      { line: 2, status: "skipped", reason: "unknown_unit" },
      { line: 3, status: "skipped", reason: "duplicate" },
      { line: 4, status: "skipped", reason: "duplicate" },
      { line: 5, status: "skipped", reason: "notes_too_long" },
    ];
    expect(groupSkipReasons(rows)).toEqual([
      { reason: "duplicate", count: 2 },
      { reason: "notes_too_long", count: 1 },
      { reason: "unknown_unit", count: 1 },
    ]);
  });

  it("buckets a skipped row that carries no reason", () => {
    expect(groupSkipReasons([{ line: 2, status: "skipped" }])).toEqual([
      { reason: "unknown", count: 1 },
    ]);
  });
});
