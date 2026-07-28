/**
 * #640 — a write that wrote nothing must never read as a success.
 *
 * The reported failure was not the parser refusing rows; it was the card
 * answering that refusal with a green tick, which is what turned a
 * recoverable problem into a silent one. These pin the classifier every
 * import card and every provider-sync card now renders from; the structural
 * guard that keeps the success affordance attached to the success outcome
 * alone lives in `src/__tests__/success-affordance-guard.test.ts`.
 */
import { describe, it, expect } from "vitest";

import {
  classifyWrittenOutcome,
  groupSkipReasons,
  resolveSyncOutcome,
} from "../written-outcome";

describe("classifyWrittenOutcome", () => {
  it("calls the reported production result a failure", () => {
    // The audit envelope from the report: 1 597 rows in, nothing written.
    expect(classifyWrittenOutcome({ written: 0, skipped: 1597 })).toBe(
      "failed",
    );
  });

  it("calls a file with no data rows empty, not a success", () => {
    expect(classifyWrittenOutcome({ written: 0, skipped: 0 })).toBe("empty");
  });

  it("calls a mixed result partial", () => {
    expect(classifyWrittenOutcome({ written: 3, skipped: 2 })).toBe("partial");
  });

  it("calls a clean result a success", () => {
    expect(classifyWrittenOutcome({ written: 5, skipped: 0 })).toBe("success");
  });

  it("never reaches success while nothing was written", () => {
    for (let written = 0; written <= 4; written++) {
      for (let skipped = 0; skipped <= 4; skipped++) {
        const outcome = classifyWrittenOutcome({ written, skipped });
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

describe("resolveSyncOutcome", () => {
  it("calls a run that wrote nothing and failed a failure, not an empty run", () => {
    // The defect: every row refused by a constraint, count 0, HTTP 200.
    expect(resolveSyncOutcome({ imported: 0, failed: true })).toEqual({
      imported: 0,
      failed: true,
      outcome: "failed",
    });
  });

  it("calls a run that found nothing new empty", () => {
    expect(resolveSyncOutcome({ imported: 0, failed: false }).outcome).toBe(
      "empty",
    );
  });

  it("calls a run with a failed leg partial even when rows landed", () => {
    expect(resolveSyncOutcome({ imported: 12, failed: true }).outcome).toBe(
      "partial",
    );
  });

  it("calls a clean run a success", () => {
    expect(resolveSyncOutcome({ imported: 12, failed: false }).outcome).toBe(
      "success",
    );
  });

  it("never reaches success while the run reported a failure", () => {
    for (const imported of [0, 1, 500]) {
      expect(resolveSyncOutcome({ imported, failed: true }).outcome).not.toBe(
        "success",
      );
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
