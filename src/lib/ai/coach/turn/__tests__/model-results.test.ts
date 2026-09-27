/**
 * v1.39.4 — the tables of a settled turn are built outside the provider's
 * failure path: a projection defect costs the turn its tables, never the
 * billed reply.
 */
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  projectResults: vi.fn(),
  annotate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/context", () => ({ annotate: m.annotate }));
vi.mock("@/lib/ai/coach/persistence", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/ai/coach/results/project", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectResults: m.projectResults,
}));

import { buildTurnResults } from "../model";

describe("buildTurnResults", () => {
  it("returns no tables and records why when the projection throws", () => {
    m.projectResults.mockImplementation(() => {
      throw new TypeError("rows is not iterable");
    });
    expect(buildTurnResults([], "en")).toEqual([]);
    expect(m.annotate).toHaveBeenCalledWith({
      action: { name: "coach.results.project_failed" },
      meta: { error: "TypeError", calls: 0 },
    });
  });

  it("passes the projected tables through with their chart", () => {
    m.projectResults.mockReturnValue([]);
    expect(buildTurnResults([], "en")).toEqual([]);
  });
});
