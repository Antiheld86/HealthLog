import { describe, expect, it } from "vitest";
import {
  extractAssessmentSummary,
  parseSummaryFromContent,
  stripJsonFences,
} from "@/lib/insights/status-shared";

/**
 * The exact malformed shape reported against the resting-pulse Assessment
 * (HealthLog#608): a truncated `{ "summary": "…` — an OPEN brace, the property
 * name, quotes and an unclosed string, with no closing `}`. Before the fix this
 * fell through the parser and rendered raw (braces, `"summary"`, quotes, literal
 * `\n`) in the Assessment card. It must resolve to the controlled fallback.
 */
const TRUNCATED_PULSE_ENVELOPE =
  '{ "summary": "Your resting pulse has been running lower than the last check';

/**
 * The Anthropic + local providers have no native JSON mode, so a compliant
 * model still routinely wraps its `{ "summary": … }` reply in a ```json
 * fence or prefixes it with a sentence. These guards pin the fence-strip
 * fallback so such replies parse instead of surfacing the raw fenced string
 * as the user-facing assessment.
 */

describe("stripJsonFences", () => {
  it("strips a ```json fence", () => {
    const out = stripJsonFences('```json\n{"summary":"ok"}\n```');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("strips a bare ``` fence", () => {
    const out = stripJsonFences('```\n{"summary":"ok"}\n```');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("narrows to the first { … last } when prose surrounds the object", () => {
    const out = stripJsonFences('Here is the result: {"summary":"ok"} done.');
    expect(out).toBe('{"summary":"ok"}');
  });

  it("is a no-op on already-clean JSON", () => {
    expect(stripJsonFences('{"summary":"ok"}')).toBe('{"summary":"ok"}');
  });

  it("returns the trimmed input when there is no object body", () => {
    expect(stripJsonFences("  plain prose  ")).toBe("plain prose");
  });
});

describe("parseSummaryFromContent", () => {
  it("parses a clean JSON envelope", () => {
    expect(parseSummaryFromContent('{"summary":"hello"}')).toBe("hello");
  });

  it("parses a ```json-fenced envelope (no native JSON mode)", () => {
    expect(parseSummaryFromContent('```json\n{"summary":"hello"}\n```')).toBe(
      "hello",
    );
  });

  it("parses a sentence-prefixed envelope", () => {
    expect(parseSummaryFromContent('Sure:\n{"summary":"hello"} — done')).toBe(
      "hello",
    );
  });

  it("falls back to the raw content for bare prose", () => {
    expect(parseSummaryFromContent("just prose, no json")).toBe(
      "just prose, no json",
    );
  });

  it("returns empty string for a truncated envelope (never the raw JSON)", () => {
    const out = parseSummaryFromContent(TRUNCATED_PULSE_ENVELOPE);
    expect(out).toBe("");
    expect(out).not.toContain('"summary"');
    expect(out).not.toContain("{");
  });
});

describe("extractAssessmentSummary", () => {
  it("classifies a structured object with a valid summary", () => {
    const out = extractAssessmentSummary('{"summary":"hello"}');
    expect(out).toEqual({ kind: "summary", text: "hello" });
  });

  it("parses a JSON STRING that carries a top-level summary", () => {
    // A provider handed back the envelope as a serialized string. It parses to
    // the same summary as an inline object — not treated as prose.
    const jsonString = JSON.stringify({
      summary: "resting pulse steady at 58",
    });
    const out = extractAssessmentSummary(jsonString);
    expect(out).toEqual({
      kind: "summary",
      text: "resting pulse steady at 58",
    });
  });

  it("classifies a fenced envelope as summary (no native JSON mode)", () => {
    const out = extractAssessmentSummary('```json\n{"summary":"hello"}\n```');
    expect(out).toEqual({ kind: "summary", text: "hello" });
  });

  it("preserves a plain-text reply as prose, verbatim", () => {
    const prose =
      "Your resting pulse is averaging 58 bpm, in line with baseline.";
    expect(extractAssessmentSummary(prose)).toEqual({
      kind: "prose",
      text: prose,
    });
  });

  it("does not treat a plain sentence containing a brace as JSON", () => {
    const prose = "Your resting pulse sits around 58 bpm {your usual range}.";
    expect(extractAssessmentSummary(prose)).toEqual({
      kind: "prose",
      text: prose,
    });
  });

  it("resolves a truncated envelope to unparseable (regression: #608)", () => {
    expect(extractAssessmentSummary(TRUNCATED_PULSE_ENVELOPE)).toEqual({
      kind: "unparseable",
    });
  });

  it("resolves a summary-less object to unparseable", () => {
    expect(extractAssessmentSummary("{}")).toEqual({ kind: "unparseable" });
  });

  it("resolves an empty-summary object to unparseable", () => {
    expect(extractAssessmentSummary('{"summary":""}')).toEqual({
      kind: "unparseable",
    });
  });
});
