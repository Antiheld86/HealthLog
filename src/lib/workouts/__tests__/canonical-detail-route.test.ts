import { describe, expect, it } from "vitest";

import { canonicalWorkoutDetailHref } from "../canonical-detail-route";

describe("canonicalWorkoutDetailHref", () => {
  it("redirects a non-canonical twin to the API-selected workout", () => {
    expect(canonicalWorkoutDetailHref("apple-row", "whoop-row")).toBe(
      "/insights/workouts/whoop-row",
    );
  });

  it("does not redirect an already canonical workout", () => {
    expect(canonicalWorkoutDetailHref("whoop-row", "whoop-row")).toBeNull();
  });

  it("rejects missing identifiers and encodes unexpected path characters", () => {
    expect(canonicalWorkoutDetailHref("apple-row", null)).toBeNull();
    expect(canonicalWorkoutDetailHref("apple-row", "   ")).toBeNull();
    expect(canonicalWorkoutDetailHref("apple-row", "../other?id=1")).toBe(
      "/insights/workouts/..%2Fother%3Fid%3D1",
    );
  });
});
