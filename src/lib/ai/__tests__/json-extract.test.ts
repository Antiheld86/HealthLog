import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../json-extract";

describe("extractJsonObject", () => {
  it("returns a plain object untouched", () => {
    expect(extractJsonObject('{"summary":"ok"}')).toBe('{"summary":"ok"}');
  });

  it("unwraps a ```json fence", () => {
    expect(extractJsonObject('```json\n{"summary":"ok"}\n```')).toBe(
      '{"summary":"ok"}',
    );
  });

  it("unwraps a bare ``` fence", () => {
    expect(extractJsonObject('```\n{"summary":"ok"}\n```')).toBe(
      '{"summary":"ok"}',
    );
  });

  it("trims a leading sentence and a trailing remark around the object", () => {
    expect(
      extractJsonObject('Here is the result:\n{"summary":"ok"}\nDone.'),
    ).toBe('{"summary":"ok"}');
  });

  it("keeps nested braces inside the outermost span", () => {
    const nested = '{"a":{"b":[{"c":1}]},"d":"}"}';
    expect(extractJsonObject(`Sure!\n${nested}`)).toBe(nested);
  });

  it("returns the trimmed input when there is no object body", () => {
    expect(extractJsonObject("  plain prose  ")).toBe("plain prose");
  });
});
