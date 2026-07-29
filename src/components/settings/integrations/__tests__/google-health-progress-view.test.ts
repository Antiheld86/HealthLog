import { describe, expect, it } from "vitest";

import {
  completedGoogleHealthResourceCount,
  failedGoogleHealthResources,
  googleHealthReasonCode,
  readGoogleHealthProgress,
} from "../google-health-progress-view";

describe("Google Health progress view", () => {
  it("preserves bounded in-progress resource completion and stable reasons", () => {
    const progress = readGoogleHealthProgress({
      data: {
        state: "in_progress",
        imported: 12,
        resources: [
          {
            resource: "workout",
            written: 12,
            status: "complete",
            reasonCode: null,
          },
          {
            resource: "sleep",
            written: 0,
            status: "failed",
            reasonCode: "collection_failed",
          },
        ],
      },
    });

    expect(progress?.state).toBe("in_progress");
    expect(progress?.imported).toBe(12);
    expect(completedGoogleHealthResourceCount(progress)).toBe(1);
    expect(failedGoogleHealthResources(progress)).toHaveLength(1);
    expect(
      googleHealthReasonCode(failedGoogleHealthResources(progress)[0]),
    ).toBe("collection_failed");
  });

  it("rejects unknown run states and does not expose unknown reason codes", () => {
    expect(readGoogleHealthProgress({ data: { state: "queued" } })).toBeNull();
    expect(
      googleHealthReasonCode({
        resource: "sleep",
        written: 0,
        status: "failed",
        reasonCode: "raw-provider-secret",
      }),
    ).toBeNull();
  });
});
