import { describe, expect, it } from "vitest";

import { clarifyAddendum } from "../clarify";
import { parseClarifySentinel } from "@/lib/ai/coach/clarify";

describe("clarifyAddendum", () => {
  it.each(["en", "de"] as const)("states the limits (%s)", (locale) => {
    const text = clarifyAddendum(locale);
    expect(text).toContain("---CLARIFY---");
    expect(text).toContain("---END---");
    for (const w of [
      "last7days",
      "last30days",
      "last90days",
      "lastYear",
      "allTime",
    ]) {
      expect(text).toContain(w);
    }
  });

  it("uses English for the other locales", () => {
    expect(clarifyAddendum("fr")).toBe(clarifyAddendum("en"));
  });

  it("teaches a block the parser accepts", () => {
    // The example in the prompt must be one the server turns into a card.
    const example = clarifyAddendum("en").match(
      /---CLARIFY---[\s\S]*?---END---/,
    )![0];
    const out = parseClarifySentinel({
      prose: `Which pulse do you mean?\n${example}`,
      inventory: ["pulse", "resting_hr", "walking_hr"].map((metric) => ({
        tool: "get_metric_series",
        metric,
        domain: metric,
        present: true,
      })),
      locale: "en",
    });
    expect(out.clarification?.choices).toHaveLength(3);
  });
});
