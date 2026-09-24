/**
 * Every mock of `@/lib/feature-flags` answers the capability loader too.
 *
 * The module has two readers of the operator's assistant switches. The AI
 * capability loader (`src/lib/ai/capabilities/load.ts`) reads
 * `loadAssistantSwitches()`; the crons and a few routes read
 * `getAssistantFlags()`. A mock that stubs only the second leaves the first
 * undefined, the loader throws, catches its own throw, and resolves every
 * capability to `check_failed`. Nothing goes red. A positive control then
 * quietly exercises the "AI unavailable" branch, and a negative case passes
 * for reason `check_failed` rather than the reason it names. That shipped in
 * an integration test whose owner-side control enqueued nothing and whose
 * delegate-side refusal proved nothing, and eight unit files carried the same
 * shape.
 *
 * So a mock of the module must say what the loader reads: either through
 * `mockAssistantSwitches` (`./helpers/assistant-switches-mock.ts`), which
 * points both readers at one source, or by naming `loadAssistantSwitches` in
 * its factory. A spread of the real module does not count: the real reader
 * then runs against whatever the file did to `@/lib/db`, which is the same
 * failure one layer down. An automock (no factory) does not count either; its
 * `loadAssistantSwitches` returns `undefined`.
 *
 * Its limit: it reads the factory's text, not its behaviour. A factory that
 * names `loadAssistantSwitches` and returns nonsense from it passes here; the
 * assertion that it returns what the test means belongs in the test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SELF = "src/__tests__/feature-flags-mock-guard.test.ts";

const ROOTS = [
  { root: join(process.cwd(), "src"), label: "src", floor: 3000 },
  { root: join(process.cwd(), "tests"), label: "tests", floor: 100 },
];

/**
 * The start of a mock of the module: `vi.mock(` or `vi.doMock(`, the path in
 * any quote style or as `import("…")`, with any whitespace and line breaks
 * between the tokens. Prettier splits long calls across lines, so a matcher
 * that assumed one line would find nothing and pass.
 */
const MOCK_START =
  /\bvi\s*\.\s*(?:doMock|mock)\s*\(\s*(?:import\s*\(\s*)?(["'`])@\/lib\/feature-flags(?:\/index(?:\.ts)?)?\1/g;

/** What a factory has to contain for the loader's reader to be answered. */
const ANSWERS_THE_LOADER =
  /\bmockAssistantSwitches\s*\(|\bloadAssistantSwitches\b/;

interface MockSite {
  file: string;
  line: number;
  /** The call's full argument text, from its `(` to the matching `)`. */
  call: string;
}

/**
 * The argument text of the call that opens at `open` (the index of its `(`),
 * by bracket balance. Good enough for test factories; it skips over string
 * literals so a `)` inside one does not close the call early.
 */
function callText(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced vi.mock call");
}

function findFeatureFlagMocks(
  files: ReadonlyArray<{ file: string; source: string }>,
): MockSite[] {
  const sites: MockSite[] = [];
  for (const { file, source } of files) {
    const code = stripComments(source);
    for (const match of code.matchAll(MOCK_START)) {
      const open = code.indexOf("(", match.index);
      sites.push({
        file,
        line: code.slice(0, match.index).split("\n").length,
        call: callText(code, open),
      });
    }
  }
  return sites;
}

function repoFiles(): Array<{ file: string; source: string }> {
  return ROOTS.flatMap(({ root, label, floor }) =>
    walkSourceFiles(root, { floor })
      .filter((rel) => !rel.startsWith("generated/"))
      // This file plants offending mocks as string literals to test its own
      // matcher; the sweep reads everything else.
      .filter((rel) => `${label}/${rel}` !== SELF)
      .map((rel) => ({
        file: `${label}/${rel}`,
        source: readFileSync(join(root, rel), "utf8"),
      })),
  );
}

describe("mocks of @/lib/feature-flags", () => {
  const sites = findFeatureFlagMocks(repoFiles());

  it("finds the mocks it is meant to police", () => {
    // Pinned at the count on the day this was written. An empty set agrees
    // with every rule below, so a matcher that stopped matching would pass
    // them all; this is what fails instead.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("every one answers the capability loader's reader", () => {
    const offenders = sites
      .filter((site) => !ANSWERS_THE_LOADER.test(site.call))
      .map((site) => `${site.file}:${site.line}`);
    expect(
      offenders,
      "These mocks leave `loadAssistantSwitches` unanswered, so the AI " +
        "capability loader throws and every capability reads `check_failed`. " +
        "Use `mockAssistantSwitches` from src/__tests__/helpers/" +
        "assistant-switches-mock.ts, or name `loadAssistantSwitches` in the " +
        "factory.",
    ).toEqual([]);
  });

  it("the matcher catches the shapes it claims to", () => {
    // The rule, run against planted sources rather than the tree, so a
    // matcher that went blind shows here and not only as a clean sweep.
    const planted = findFeatureFlagMocks([
      {
        file: "one-line.test.ts",
        source: `vi.mock("@/lib/feature-flags", () => ({ getAssistantFlags: vi.fn() }));`,
      },
      {
        file: "split.test.ts",
        source: `vi\n  .mock(\n  '@/lib/feature-flags',\n  async (orig) => ({ ...(await orig()), getAssistantFlags: vi.fn() }),\n);`,
      },
      { file: "automock.test.ts", source: `vi.mock("@/lib/feature-flags");` },
      {
        file: "do-mock.test.ts",
        source: `vi.doMock(import("@/lib/feature-flags"), () => ({}));`,
      },
      {
        file: "commented.test.ts",
        source: `// vi.mock("@/lib/feature-flags", () => ({}));`,
      },
      {
        file: "helper.test.ts",
        source: `vi.mock("@/lib/feature-flags", async () =>\n  (await import("x")).mockAssistantSwitches(() => f()),\n);`,
      },
      {
        file: "named.test.ts",
        source: `vi.mock("@/lib/feature-flags", () => ({ loadAssistantSwitches: vi.fn(async () => null) }));`,
      },
      {
        file: "other-module.test.ts",
        source: `vi.mock("@/lib/feature-flags-extra", () => ({}));`,
      },
    ]);
    const verdict = Object.fromEntries(
      planted.map((site) => [site.file, ANSWERS_THE_LOADER.test(site.call)]),
    );
    expect(verdict).toEqual({
      "one-line.test.ts": false,
      "split.test.ts": false,
      "automock.test.ts": false,
      "do-mock.test.ts": false,
      "helper.test.ts": true,
      "named.test.ts": true,
    });
  });
});
