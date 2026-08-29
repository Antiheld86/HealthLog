import { describe, it, expect } from "vitest";
import { stripHtml } from "@/lib/notifications/strip-html";

/**
 * The five plain-text senders used to strip tags with a local single-pass
 * regex replace (CodeQL: incomplete multi-character sanitization). The
 * hardened shared helper re-applies the strip until the string stops
 * changing, so a tag re-formed by an earlier removal cannot survive. These
 * cases pin the invariant that matters — no tag-shaped sequence in any
 * output — and identity on plain input.
 */
describe("stripHtml", () => {
  it("leaves plain input unchanged", () => {
    expect(stripHtml("Blood pressure logged: 120/80")).toBe(
      "Blood pressure logged: 120/80",
    );
    expect(stripHtml("")).toBe("");
  });

  it("strips simple tags exactly like the old single pass", () => {
    expect(stripHtml("<b>urgent</b> reading")).toBe("urgent reading");
    expect(stripHtml("line<br/>break")).toBe("linebreak");
    expect(stripHtml("a < b and b > a")).toBe("a  a");
  });

  it("removes the classic nested-tag bypass shapes", () => {
    expect(stripHtml("<<b>script>alert(1)")).toBe("script>alert(1)");
    expect(stripHtml("<<b>script>")).toBe("script>");
    expect(stripHtml("<<<i><b>script>>payload")).toBe("script>>payload");
  });

  it("never lets a tag-shaped sequence survive any adversarial input", () => {
    const hostile = [
      "<<b>script>alert(1)<</b>/script>",
      "<scr<b>ipt>alert(1)</scr<b>ipt>",
      "<".repeat(64) + "b>".repeat(64) + "script>alert(1)",
      '<img src=">" onerror=alert(1)>',
      "<a<b<c<d>e>f>g>",
    ];
    for (const input of hostile) {
      expect(stripHtml(input), input).not.toMatch(/<[^>]*>/);
    }
  });

  it("handles unterminated brackets without stripping legitimate text", () => {
    // No closing `>` anywhere after the `<` — nothing tag-shaped to remove.
    expect(stripHtml("<div")).toBe("<div");
    expect(stripHtml("2 < 3 <b")).toBe("2 < 3 <b");
  });
});
