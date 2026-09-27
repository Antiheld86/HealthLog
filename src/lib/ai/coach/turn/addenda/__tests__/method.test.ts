import { describe, expect, it } from "vitest";

import { methodAddendum } from "../method";
import { buildDialogAddenda } from "..";

describe("methodAddendum", () => {
  it.each(["en", "de"] as const)("carries the recheck rule (%s)", (locale) => {
    const text = methodAddendum(locale);
    expect(text).toContain("show_result");
    expect(text.length).toBeGreaterThan(200);
  });

  it("tells the model to re-read and correct, not defend", () => {
    const text = methodAddendum("en");
    expect(text).toMatch(/fetch it again/);
    expect(text).toMatch(/correct your answer/);
    expect(text).toMatch(/name the source and the window/);
  });

  it("uses English for the other locales", () => {
    expect(methodAddendum("pl")).toBe(methodAddendum("en"));
  });
});

describe("buildDialogAddenda", () => {
  it("leaves the recheck and follow-up rules out until there is a table", () => {
    const without = buildDialogAddenda("en", { tableRules: false });
    const withTables = buildDialogAddenda("en", { tableRules: true });
    expect(without).toContain("RESULT TABLES");
    expect(without).toContain("CLARIFYING QUESTIONS");
    expect(without).not.toContain("RECHECKING A FIGURE");
    expect(without).not.toContain("FOLLOW-UP SUGGESTIONS");
    expect(withTables).toContain("RECHECKING A FIGURE");
    expect(withTables).toContain("FOLLOW-UP SUGGESTIONS");
  });
});
