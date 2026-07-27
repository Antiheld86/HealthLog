/**
 * The outcome presentation, pinned per state.
 *
 * The classifier is proved in `src/lib/outcome/__tests__/written-outcome.test.ts`
 * and the structural rule in `src/__tests__/success-affordance-guard.test.ts`.
 * This is the middle piece: that the tick and the success colour are attached
 * to the `success` state and to no other, and that the toast twin picks the
 * matching sonner variant. Project convention is SSR-only component tests, so
 * the line is rendered directly.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const toastCalls: Array<{ variant: string; message: string }> = [];
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastCalls.push({ variant: "success", message: m }),
    warning: (m: string) => toastCalls.push({ variant: "warning", message: m }),
    error: (m: string) => toastCalls.push({ variant: "error", message: m }),
    info: (m: string) => toastCalls.push({ variant: "info", message: m }),
  },
}));

import { toastWrittenOutcome } from "../outcome-toast";
import { WrittenOutcomeLine } from "../written-outcome-line";
import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

function render(outcome: WrittenOutcome) {
  return renderToStaticMarkup(
    <WrittenOutcomeLine outcome={outcome} message="msg" testId="probe" />,
  );
}

describe("WrittenOutcomeLine", () => {
  it("carries the success colour only on the success state", () => {
    expect(render("success")).toContain("text-success");
    for (const other of ["partial", "failed", "empty"] as const) {
      expect(render(other)).not.toContain("text-success");
    }
  });

  it("exposes the outcome as a stable attribute for the tests below the UI", () => {
    for (const outcome of [
      "success",
      "partial",
      "failed",
      "empty",
    ] as const satisfies readonly WrittenOutcome[]) {
      expect(render(outcome)).toContain(`data-outcome="${outcome}"`);
    }
  });

  it("alerts on a result that did not fully write, and only reports otherwise", () => {
    // A run that saved nothing is the one a user must not scroll past.
    expect(render("failed")).toContain('role="alert"');
    expect(render("partial")).toContain('role="alert"');
    expect(render("success")).toContain('role="status"');
    expect(render("empty")).toContain('role="status"');
  });
});

describe("toastWrittenOutcome", () => {
  it("raises the success toast only for a success", () => {
    toastCalls.length = 0;
    toastWrittenOutcome("success", "a");
    toastWrittenOutcome("partial", "b");
    toastWrittenOutcome("failed", "c");
    toastWrittenOutcome("empty", "d");
    expect(toastCalls).toEqual([
      { variant: "success", message: "a" },
      { variant: "warning", message: "b" },
      { variant: "error", message: "c" },
      { variant: "info", message: "d" },
    ]);
  });
});
