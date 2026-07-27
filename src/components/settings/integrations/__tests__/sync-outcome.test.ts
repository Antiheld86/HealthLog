/**
 * What a card is allowed to believe about a sync response.
 *
 * The cards used to read `res.ok` and print `json.data.imported`. They now
 * read the resolved outcome the route computed, and refuse to guess: an
 * envelope that does not carry all three fields is treated as a failed run,
 * not as a success with a missing count. An unreadable answer is not evidence
 * of a write.
 */
import { describe, expect, it } from "vitest";

import { readSyncOutcome } from "../sync-outcome";

describe("readSyncOutcome", () => {
  it("narrows a well-formed envelope", () => {
    expect(
      readSyncOutcome({
        data: { imported: 0, failed: true, outcome: "failed" },
        error: null,
      }),
    ).toEqual({ imported: 0, failed: true, outcome: "failed" });
  });

  it("refuses an envelope that carries only the count", () => {
    // The pre-fix shape. A card that accepted it would be back to reporting a
    // number with no verdict attached.
    expect(readSyncOutcome({ data: { imported: 12 }, error: null })).toBeNull();
  });

  it("refuses an unknown outcome value", () => {
    expect(
      readSyncOutcome({
        data: { imported: 1, failed: false, outcome: "ok" },
        error: null,
      }),
    ).toBeNull();
  });

  it("refuses an error envelope and anything that is not one at all", () => {
    expect(readSyncOutcome({ data: null, error: "boom" })).toBeNull();
    expect(readSyncOutcome(null)).toBeNull();
    expect(readSyncOutcome("nope")).toBeNull();
  });
});
