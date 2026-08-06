import { describe, expect, it } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * An interpolated value is substituted literally, whatever is in it.
 *
 * ## The defect
 *
 * Both translators filled `{param}` with
 * `value.replace(new RegExp("\\{k\\}", "g"), String(v))`, and a replacement
 * STRING is not literal text: `String.prototype.replace` reads `$&`, `` $` ``,
 * `$'`, `$1` and `$$` out of it. So a value containing `$'` splices in
 * everything that followed the placeholder, `` $` `` splices in everything
 * before it, and `$&` repeats the placeholder itself. The sentence a person
 * reads is then not the sentence the bundle holds.
 *
 * Every value that reaches this path is user-controlled, and the ones that
 * matter most are the ones this release added: a display name lands in
 * "{name} removed a reading" and in "{name} tried to change a dose and was
 * refused", on the panel where an owner works out what somebody did in their
 * health record. A name of `$'` turns "Alex removed a reading" into a sentence
 * with the wrong subject and no way for the reader to tell.
 *
 * Not an injection in the XSS sense — the result is React text children, and
 * this repository ships no markdown renderer for exactly that reason. It is a
 * correctness and honesty defect in an audit-facing sentence, which on this
 * surface is the more expensive kind.
 *
 * ## The fix, and why the test is written this way
 *
 * A replacer FUNCTION. Its return value is used verbatim and has no `$`
 * grammar at all, which removes the whole class rather than escaping the
 * members of it somebody thought of.
 *
 * The cases below are the five `$` forms plus a plain control, and each
 * asserts the WHOLE sentence rather than that it contains the value: a
 * splice adds text without removing the value, so "contains" would pass on
 * every one of them.
 */
describe("a translated sentence survives its own parameters", () => {
  const t = getServerTranslator("en").t;
  // A real key with one placeholder, and it is one of the ones this release
  // added — the sharing activity line an owner reads about somebody else.
  const KEY = "recordSharing.activityVerb.measurementDelete";

  it("has a template with exactly one placeholder", () => {
    // The pin. A key whose text lost its `{name}` would make every case below
    // pass by never substituting anything.
    const raw = t(KEY);
    expect(raw).toContain("{name}");
    expect(raw.match(/\{name\}/g)).toHaveLength(1);
    expect(t(KEY, { name: "Alex" })).toBe("Alex removed a reading");
  });

  const hostile = [
    { label: "the trailing-context form", value: "$'" },
    { label: "the leading-context form", value: "$`" },
    { label: "the whole-match form", value: "$&" },
    { label: "a capture reference", value: "$1" },
    { label: "an escaped dollar", value: "$$" },
    { label: "a plain name, as the control", value: "Alex" },
  ] as const;

  for (const { label, value } of hostile) {
    it(`substitutes ${label} verbatim`, () => {
      expect(t(KEY, { name: value })).toBe(`${value} removed a reading`);
    });
  }

  it("substitutes every occurrence, and only the named placeholder", () => {
    // The `g` flag is load-bearing for keys that name a value twice, and the
    // replacer must not change that.
    const both = getServerTranslator("en").t("recordSharing.activity.opened", {
      name: "$'",
      count: 3,
    });
    expect(both).toContain("$'");
    expect(both).toContain("3");
    expect(both).not.toContain("{name}");
    expect(both).not.toContain("{count}");
  });
});
