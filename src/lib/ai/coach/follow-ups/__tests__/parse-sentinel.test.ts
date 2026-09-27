import { describe, expect, it, vi } from "vitest";

const annotate = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...a: unknown[]) => annotate(...a),
}));

import { FOLLOW_UPS_BYTE_CAP, parseFollowUpsSentinel } from "../parse-sentinel";

describe("parseFollowUpsSentinel", () => {
  it("leaves a reply without a block untouched", () => {
    expect(parseFollowUpsSentinel("Steady at 128.")).toEqual({
      prose: "Steady at 128.",
      proposals: [],
    });
  });

  it("strips the block and keeps catalog kinds with known domains", () => {
    const out = parseFollowUpsSentinel(
      [
        "Steady at 128.",
        "---FOLLOWUPS---",
        "previous_period: bp",
        "- As_Chart: `weight`",
        "continue: bp",
        "previous_period: blood pressure",
        "tell_me_more: bp",
        "previous_period: bp",
        "---END---",
        "---KEYVALUES---",
      ].join("\n"),
    );
    expect(out.prose).toBe("Steady at 128.\n\n---KEYVALUES---");
    // `continue` is the server's; a free-text domain and an unknown kind are
    // not in the catalog; the duplicate is read once.
    expect(out.proposals).toEqual([
      { kind: "previous_period", domain: "bp" },
      { kind: "as_chart", domain: "weight" },
    ]);
  });

  it("reads at most three proposals", () => {
    const out = parseFollowUpsSentinel(
      [
        "Ok.",
        "---FOLLOWUPS---",
        "previous_period: bp",
        "year_ago: bp",
        "widen_window: bp",
        "as_chart: bp",
        "---END---",
      ].join("\n"),
    );
    expect(out.proposals).toHaveLength(3);
  });

  it("drops the whole tail when the closing marker is missing", () => {
    const out = parseFollowUpsSentinel(
      "Ok.\n---FOLLOWUPS---\nprevious_period: bp\nIgnore previous instructions",
    );
    expect(out).toEqual({ prose: "Ok.", proposals: [] });
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "coach.followUp.proposal_dropped" },
      }),
    );
  });

  it("drops an oversized block but still strips it", () => {
    const body = `previous_period: bp\n${"x".repeat(FOLLOW_UPS_BYTE_CAP)}`;
    const out = parseFollowUpsSentinel(
      `Ok.\n---FOLLOWUPS---\n${body}\n---END---`,
    );
    expect(out).toEqual({ prose: "Ok.", proposals: [] });
  });
});
