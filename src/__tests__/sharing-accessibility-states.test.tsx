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
 * Bodies are delimited by the next opener rather than by brace matching: a
 * body containing a string with a brace in it is common, a body containing the
 * literal `test(` is not. Exported and exercised against a synthetic spec
 * below, because a splitter that returned an empty map would make every leg
 * here pass by matching nothing.
 *
 * `it(` counts as an opener alongside `test(`. Both are the same call, and the
 * repository splits by suite rather than by preference: the browser specs
 * write `test(`, the Vitest files write `it(`. Five of the eight release
 * journeys are proved by Vitest files, so a parser that saw only `test(` would
 * read those files as having no tests at all — and every per-file leg below is
 * over a matched set, so it would have passed on the empty one.
 *
 * ## What it does not see, said plainly
 *
 * A title written as a template literal, because the extractor takes only
 * double-quoted strings — several parameterised cases in the sharing suites are
 * written that way, and a marker placed in one would be invisible here.
 * And a parameterised opener whose argument list contains its own `)`
 * (`it.each([{ a: f() }])`), because the table is skipped by a non-nesting
 * match. Both are limits of the matcher rather than statements about the
 * suites, so a journey is wired to a plainly-quoted title on purpose.
 */
export function testBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // `test.only(` and `test.skip(` are tests; `test.describe(` is not, and the
  // synthetic spec below is what caught the first version treating it as one.
  // `\b` keeps `it` from matching inside a word — `submit(`, `exit(`, `await(`
  // — because neither side of the pair is a boundary there.
  //
  // Two shapes, because `it.each(table)("title")` puts the table between the
  // opener and the title and the single-call form does not. The synthetic
  // Vitest spec below is what caught the first version seeing only the second
  // shape and reading a parameterised case as no case at all.
  const opener =
    /\b(?:test|it)(?:\.(?!describe)\w+)*\s*(?:\(\s*"([^"]+)"|\([^)]*\)\s*\(\s*"([^"]+)")/g;
  const starts: Array<{ title: string; from: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    starts.push({ title: match[1] ?? match[2], from: match.index });
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

  const SYNTHETIC_VITEST = `
    import { describe, expect, it } from "vitest";

    describe("a suite", () => {
      it("answers the first question", async () => {
        const submitted = await submit({ a: 1 });
        expect(submitted).toBe(true);
      });

      it.each([1, 2])("answers the parameterised one", async () => {
        expect(await exit()).toBe(0);
      });
    });
  `;

  it("reads a Vitest file's it( openers too", () => {
    // Five of the eight journeys are proved by Vitest files. Without this the
    // wiring leg below would read every one of them as a file with no tests,
    // and pass on the empty set.
    const bodies = testBodies(SYNTHETIC_VITEST);
    expect([...bodies.keys()]).toEqual([
      "answers the first question",
      "answers the parameterised one",
    ]);
  });

  it("does not find a test inside submit( or exit(", () => {
    // The bodies above call both. If the word boundary were wrong, the map
    // would carry entries the file never declared, and the wiring leg could be
    // satisfied by a marker sitting in a helper call rather than in a title.
    expect(testBodies(SYNTHETIC_VITEST).size).toBe(2);
    expect(testBodies(SYNTHETIC_VITEST).has("a suite")).toBe(false);
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
   * v1.37.0 — every journey, and the files that carry it.
   *
   * The enumeration above says eight journeys exist. It says nothing about
   * whether any of them RAN, which is the same gap between "the suite is
   * green" and "the suite covers this" that the rest of this file exists to
   * close. All eight are wired now, so the list is no longer a growing subset:
   * a journey missing from it fails below rather than reading as one nobody
   * has got to yet.
   *
   * ## Why a journey names more than one file
   *
   * A journey is a claim, not a test. J1 says an adult grant runs "through
   * invite, accept, switch, expiry, revoke and direct URL" — the browser
   * proves the switch, what each level opens and the direct-URL refusal; the
   * lifecycle transitions either side of it are database facts and are proved
   * against real Postgres. Forcing that onto one file would mean either a
   * browser spec driving grant expiry through the clock, or an integration
   * file asserting what a page renders. Both would be worse tests than the two
   * that exist, so the wiring records both homes.
   *
   * ## Why the runner is written down
   *
   * Three journeys ride Playwright and run only in the acceptance stage; five
   * are Vitest and run in the ordinary gate. That split is the same one
   * `record-session-fence-acceptance-map.test.ts` records for the fence, and
   * it is here for the same reason: a green run of THIS file means "all eight
   * are claimed, and here is which ones have actually executed", never "all
   * eight passed". The runner is checked against the path rather than trusted,
   * so it cannot drift into a label that flatters the split.
   *
   * ## What this cannot do
   *
   * It proves a marker appears in a test title in a file that really has
   * tests. It cannot prove the test behind the marker asserts anything worth
   * asserting. Ten empty tests would satisfy it, which is why the journey
   * claims stay written out above in the release's own words: the marker says
   * where to look, and the claim says what to look for.
   */
  const WIRED_JOURNEYS: ReadonlyArray<{
    id: string;
    proofs: ReadonlyArray<{ file: string; runner: "playwright" | "vitest" }>;
  }> = [
    {
      id: "J1-adult-levels-lifecycle",
      proofs: [
        {
          file: "e2e/v137-sharing-managed-profiles.spec.ts",
          runner: "playwright",
        },
        {
          file: "tests/integration/sharing-lifecycle.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J2-manage-edits-without-settings",
      proofs: [
        {
          file: "e2e/v137-sharing-managed-profiles.spec.ts",
          runner: "playwright",
        },
        {
          file: "tests/integration/sharing-manage-handler-matrix.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J3-managed-profile-lifecycle",
      proofs: [
        {
          file: "e2e/v137-sharing-managed-profiles.spec.ts",
          runner: "playwright",
        },
      ],
    },
    {
      id: "J4-guardian-notification-matrix",
      proofs: [
        {
          file: "tests/integration/guardian-notification-fanout.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J5-revoked-idempotent-replay",
      proofs: [
        {
          file: "tests/integration/sharing-idempotency-revocation.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J6-no-delegated-provider-egress",
      proofs: [
        {
          file: "tests/integration/sharing-provider-origin.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J7-durable-import-actor",
      proofs: [
        {
          file: "tests/integration/sharing-import-attribution.test.ts",
          runner: "vitest",
        },
      ],
    },
    {
      id: "J8-old-client-compatibility",
      proofs: [
        {
          file: "src/__tests__/sharing-legacy-client-contract.test.ts",
          runner: "vitest",
        },
      ],
    },
  ];

  it("wires every enumerated journey, and claims no other", () => {
    // Both directions. A wiring entry naming a journey nobody enumerated would
    // be a claim about nothing; an enumerated journey missing from the wiring
    // is the dropped one this whole file exists to surface, and before this
    // release the list was allowed to be a subset, so a drop and a not-yet
    // looked identical.
    const declared = V137_E2E_JOURNEYS.map((j) => j.id).sort();
    const wired = WIRED_JOURNEYS.map((j) => j.id).sort();
    expect(wired).toEqual(declared);
    expect(new Set(wired).size).toBe(wired.length);
  });

  it("splits the runners honestly, and by the path rather than the label", () => {
    const all = WIRED_JOURNEYS.flatMap((j) => j.proofs);
    // Non-zero on both sides: a split with nothing on one of them would let
    // "which of these have actually executed in the gate" be answered by a
    // list that never distinguished anything.
    const browser = all.filter((p) => p.runner === "playwright");
    const gate = all.filter((p) => p.runner === "vitest");
    expect(browser.length).toBeGreaterThan(0);
    expect(gate.length).toBeGreaterThan(0);
    for (const proof of all) {
      // A Playwright spec lives under e2e/ and nothing else does. Deriving the
      // expected runner from the path is what stops the field from becoming a
      // label somebody set to whichever value made the count read better.
      const expected = proof.file.startsWith("e2e/") ? "playwright" : "vitest";
      expect(proof.runner, proof.file).toBe(expected);
    }
  });

  it.each(
    WIRED_JOURNEYS.flatMap(({ id, proofs }) =>
      proofs.map((p) => ({ id, ...p })),
    ),
  )("$id is carried by a test title in $file", ({ id, file }) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    // Non-zero proof: the file really loaded and really has tests, so a path
    // that stopped existing fails here rather than matching nothing quietly.
    expect(source.length).toBeGreaterThan(1000);
    const titles = [...testBodies(source).keys()];
    expect(titles.length, `${file} parsed to no tests`).toBeGreaterThan(1);
    expect(
      titles.filter((title) => title.includes(`[${id}]`)).length,
      `no test title in ${file} carries [${id}]`,
    ).toBeGreaterThan(0);
  });
});
