import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCESSIBILITY_STATES,
  SHARING_ACCESSIBILITY_STATES,
  V137_E2E_JOURNEYS,
} from "../../tests/fixtures/v137/e2e-journeys";

/**
 * All five states are claimed by a browser test that really examines them.
 *
 * ## Why a fast test guards a browser suite
 *
 * A Playwright run reports what it ran, never what it did not. "The
 * accessibility suite is green" and "the accessibility suite covers the error
 * state" are different sentences, and only the first one is ever checked —
 * a state nobody wrote a test for produces exactly the same output as a state
 * that passes. Before this file the suite had four tests for five states, with
 * success and empty sharing one and neither of them actually entering an empty
 * one.
 *
 * So the states are enumerated in `tests/fixtures/v137/e2e-journeys.ts` and
 * this file reads the spec back against the list. It cannot tell whether the
 * assertions inside a test are any good. It can tell that each state has a
 * test, that the test enters the state (there is an anchor, and the anchor is
 * a slot the component tree really renders), and that the test performs each
 * proof the state's own record says it needs — scan, reader order, and either
 * a keyboard reach or an announcement.
 *
 * ## The trap this file is written around
 *
 * Every assertion here is over a MATCHED set, and an empty match set satisfies
 * most of them silently: a spec path that no longer exists reads as a spec
 * with no offending tests. Each leg therefore pins the size of what it
 * matched — five states, five titles, eight journeys, a non-zero count of
 * helper calls — and the parse is proved against a synthetic spec at the
 * bottom, so the day the extractor stops seeing `test("…")` is the day this
 * file fails rather than the day it goes quiet.
 */
const ROOT = process.cwd();
const A11Y_SPEC = join(ROOT, "e2e/v137-sharing-managed-profiles-a11y.spec.ts");

/** The helper each state's test has to call, by what the state offers. */
const SCAN = "scanForViolations";
const READER_ORDER = "expectReaderOrder";
const KEYBOARD = "expectKeyboardReach";
const ANNOUNCED = "expectAnnounced";
const CONTRAST = "expectContentContrast";

/**
 * Split a spec into `title -> body`.
 *
 * Bodies are delimited by the next `test(` rather than by brace matching: a
 * body containing a string with a brace in it is common, a body containing the
 * literal `test(` is not. Exported and exercised against a synthetic spec
 * below, because a splitter that returned an empty map would make every leg
 * here pass by matching nothing.
 */
export function testBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // `test.only(` and `test.skip(` are tests; `test.describe(` is not, and the
  // synthetic spec below is what caught the first version treating it as one.
  const opener = /\btest(?:\.(?!describe)\w+)*\(\s*"([^"]+)"/g;
  const starts: Array<{ title: string; from: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    starts.push({ title: match[1], from: match.index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const to = i + 1 < starts.length ? starts[i + 1].from : source.length;
    bodies.set(starts[i].title, source.slice(starts[i].from, to));
  }
  return bodies;
}

describe("the state parser sees what it looks for", () => {
  const SYNTHETIC = `
    import { expect, test } from "./setup/test";

    test.describe("a group", () => {
      test("first — success", async ({ page }) => {
        await scanForViolations(page);
      });

      test("second — refusal", async ({ page }) => {
        await expectKeyboardReach(page, '[data-slot="x"]');
      });
    });
  `;

  it("splits a spec into its test bodies", () => {
    const bodies = testBodies(SYNTHETIC);
    expect([...bodies.keys()]).toEqual(["first — success", "second — refusal"]);
    expect(bodies.get("first — success")).toContain(SCAN);
    // And no body bleeds into the next one, which is what would make a single
    // well-instrumented test satisfy the checks for every state.
    expect(bodies.get("first — success")).not.toContain(KEYBOARD);
  });

  it("does not treat a describe block as a test", () => {
    expect(testBodies(SYNTHETIC).has("a group")).toBe(false);
  });
});

describe("the five states are enumerated once each", () => {
  it("lists exactly the five, with no state named twice", () => {
    expect(ACCESSIBILITY_STATES).toHaveLength(5);
    expect(SHARING_ACCESSIBILITY_STATES).toHaveLength(5);
    expect(SHARING_ACCESSIBILITY_STATES.map((c) => c.state).sort()).toEqual(
      [...ACCESSIBILITY_STATES].sort(),
    );
  });

  it("anchors every state on a slot the tree really renders", () => {
    // A state can otherwise be added to the list with an anchor nothing emits,
    // and the browser test would then wait for an element that cannot appear —
    // which fails, but fails as a timeout that reads like flake rather than
    // like a missing surface.
    for (const c of SHARING_ACCESSIBILITY_STATES) {
      const source = readFileSync(join(ROOT, c.rendersIn), "utf8");
      // The last `[data-slot="…"]` in a compound selector is the one the
      // module has to emit; the prefix is context from an ancestor.
      const slots = [...c.anchor.matchAll(/data-slot="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(slots.length, c.anchor).toBeGreaterThan(0);
      expect(source, `${c.rendersIn} does not emit ${c.anchor}`).toContain(
        `data-slot="${slots[slots.length - 1]}"`,
      );
    }
  });

  it("gives every state a way forward or says it has none", () => {
    // Exactly one state may be without a control, and it is the one nobody can
    // act in. A second `null` here would mean a dead end shipped as a state.
    const dead = SHARING_ACCESSIBILITY_STATES.filter(
      (c) => c.keyboardTarget === null,
    );
    expect(dead.map((c) => c.state)).toEqual(["loading"]);
  });
});

describe("every state is claimed by a browser test that examines it", () => {
  const spec = readFileSync(A11Y_SPEC, "utf8");
  const bodies = testBodies(spec);

  it("parses a non-zero number of tests out of the spec", () => {
    // The pin the legs below rest on: an empty map satisfies "no state is
    // missing a helper call" perfectly.
    expect(bodies.size).toBeGreaterThanOrEqual(
      SHARING_ACCESSIBILITY_STATES.length,
    );
  });

  for (const c of SHARING_ACCESSIBILITY_STATES) {
    describe(c.state, () => {
      const body = [...bodies.entries()].find(([title]) =>
        title.includes(`[${c.state}]`),
      )?.[1];

      it("has a test that names the state", () => {
        expect(
          body,
          `no test title carries [${c.state}] in ${A11Y_SPEC}`,
        ).toBeDefined();
      });

      it("enters the state before it asserts anything about it", () => {
        expect(body ?? "", c.anchor).toContain(c.anchor);
      });

      it("scans it and proves the reading order", () => {
        expect(body ?? "").toContain(SCAN);
        expect(body ?? "").toContain(READER_ORDER);
      });

      it(
        c.keyboardTarget === null
          ? "announces itself, having nothing to press"
          : "puts its way forward within reach of a keyboard",
        () => {
          if (c.keyboardTarget === null) {
            expect(body ?? "").toContain(ANNOUNCED);
            expect(body ?? "").not.toContain(KEYBOARD);
          } else {
            expect(body ?? "").toContain(KEYBOARD);
            expect(body ?? "").toContain(c.keyboardTarget);
          }
        },
      );

      it(
        c.contrastTarget === null
          ? "has no visible copy to check"
          : "renders its material copy as content, not as muted meta",
        () => {
          if (c.contrastTarget === null) {
            expect(body ?? "").not.toContain(CONTRAST);
          } else {
            expect(body ?? "").toContain(CONTRAST);
            expect(body ?? "").toContain(c.contrastTarget);
          }
        },
      );
    });
  }

  it("defines every helper it demands", () => {
    // Otherwise the checks above are satisfied by a call to a function that
    // does not exist, which typechecks nowhere this guard can see.
    for (const helper of [SCAN, READER_ORDER, KEYBOARD, ANNOUNCED, CONTRAST]) {
      expect(spec, helper).toMatch(
        new RegExp(`(async\\s+function|const)\\s+${helper}\\b`),
      );
    }
  });
});

describe("the eight release journeys are enumerated", () => {
  it("names exactly eight, with distinct ids", () => {
    expect(V137_E2E_JOURNEYS).toHaveLength(8);
    expect(new Set(V137_E2E_JOURNEYS.map((j) => j.id)).size).toBe(8);
    for (const journey of V137_E2E_JOURNEYS) {
      expect(journey.claim.length, journey.id).toBeGreaterThan(40);
    }
  });

  /**
   * v1.37.0 — the ids that are wired to a test title, and only those.
   *
   * The enumeration above says eight journeys exist. It says nothing about
   * whether any of them RAN, which is the same gap between "the suite is
   * green" and "the suite covers this" that the rest of this file exists to
   * close. Wiring all eight is the integration plan's item; this list is the
   * subset already claimed by a spec, and it grows as they land.
   *
   * An id on this list whose spec loses the marker fails here rather than
   * disappearing quietly from a run nobody counted.
   */
  const WIRED_JOURNEYS: ReadonlyArray<{ id: string; spec: string }> = [
    {
      id: "J3-managed-profile-lifecycle",
      spec: "e2e/v137-sharing-managed-profiles.spec.ts",
    },
  ];

  it("claims only ids the enumeration actually declares", () => {
    // A wiring entry naming a journey nobody enumerated would be a claim about
    // nothing, and would make the leg below pass against a marker that means
    // no more than the string it is.
    expect(WIRED_JOURNEYS.length).toBeGreaterThan(0);
    const declared = new Set(V137_E2E_JOURNEYS.map((j) => j.id));
    for (const { id } of WIRED_JOURNEYS) {
      expect(declared, id).toContain(id);
    }
  });

  it.each(WIRED_JOURNEYS)("$id is carried by a test title", ({ id, spec }) => {
    const source = readFileSync(join(ROOT, spec), "utf8");
    // Non-zero proof: the spec really loaded and really has tests, so a path
    // that stopped existing fails here rather than matching nothing quietly.
    expect(source.length).toBeGreaterThan(1000);
    const titles = [...testBodies(source).keys()];
    expect(titles.length).toBeGreaterThan(1);
    expect(
      titles.filter((title) => title.includes(`[${id}]`)).length,
      `no test title in ${spec} carries [${id}]`,
    ).toBeGreaterThan(0);
  });
});
