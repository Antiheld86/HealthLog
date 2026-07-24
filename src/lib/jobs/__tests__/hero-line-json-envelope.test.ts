import { describe, expect, it, vi } from "vitest";

// The sanitisers are pure, but their modules import the db client at load time.
// Stub it so the unit under test never reaches for a connection.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { sanitiseReactionLine } from "@/lib/jobs/reaction-line";
import { sanitiseAiBody } from "@/lib/jobs/coach-nudge-ai";

/**
 * v1.32.20 — both background hero lines (the arrival reaction and the coach
 * nudge body) now run the status cards' structured-envelope detection
 * (`extractAssessmentSummary`). A hero line is one plain sentence; a brace-led
 * or fenced `{"line":"…"}` reply, or a truncated envelope under the char cap,
 * is a broken contract and must resolve to the deterministic lead/template
 * rather than render raw JSON. Genuine prose still ships.
 */
describe("sanitiseReactionLine — JSON-envelope detection", () => {
  it("rejects a well-formed JSON envelope so the deterministic lead stands", () => {
    expect(
      sanitiseReactionLine(
        '{"line":"Nice work today, your numbers are holding steady."}',
        "en",
      ),
    ).toBeNull();
  });

  it("rejects a truncated brace-led envelope", () => {
    expect(sanitiseReactionLine('{"line":"Nice work today', "en")).toBeNull();
  });

  it("rejects a fenced JSON envelope", () => {
    expect(
      sanitiseReactionLine('```json\n{"line":"Steady week."}\n```', "en"),
    ).toBeNull();
  });

  it("still renders a plain-text line verbatim", () => {
    expect(
      sanitiseReactionLine(
        "Nice work today, your numbers are holding steady.",
        "en",
      ),
    ).toBe("Nice work today, your numbers are holding steady.");
  });
});

describe("sanitiseAiBody — JSON-envelope detection", () => {
  it("rejects a well-formed JSON envelope so the template stands", () => {
    expect(
      sanitiseAiBody(
        '{"body":"A gentle check-in on your routine this week."}',
        "en",
      ),
    ).toBeNull();
  });

  it("rejects a truncated brace-led envelope", () => {
    expect(sanitiseAiBody('{"body":"A gentle check-in', "en")).toBeNull();
  });

  it("still renders a plain-text body verbatim", () => {
    expect(
      sanitiseAiBody("A gentle check-in on your routine this week.", "en"),
    ).toBe("A gentle check-in on your routine this week.");
  });
});
