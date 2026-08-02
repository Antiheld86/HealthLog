/**
 * The one file walker the structural guards share.
 *
 * ## Why this exists rather than `fs.globSync`
 *
 * A guard that freezes a discovered set against an allowlist is only as
 * honest as its idea of "every source file". `fs.globSync` has a rule that
 * silently narrows that idea: a glob's `*` never matches a leading dot, so
 * `**\/*.{ts,tsx}` skips every dot-prefixed directory without saying so.
 *
 * `src/app/.well-known/` holds three live route modules — the two OAuth
 * discovery documents the MCP server publishes and the
 * apple-app-site-association handler. Every guard built on `globSync` walked
 * straight past all three and reported a clean sweep over a tree with a hole
 * in it. Demonstrated, not assumed: an unlisted `getSession()` call planted
 * in `app/.well-known/oauth-authorization-server/route.ts` left
 * `session-surface-guard` at 9 passed, and fails it once the walk goes
 * through here.
 *
 * `readdirSync(root, { recursive: true })` has no dot rule. It is the reason
 * `delegable-surface-guard.test.ts` already walks by hand; this helper makes
 * that the shared behaviour instead of one guard's private correction.
 *
 * ## Why `floor` is required and not optional
 *
 * The other way a sweep goes quiet is by finding nothing at all: an empty
 * match set agrees with an empty allowlist, and the guard passes on a tree it
 * never read. A wrong root, a renamed directory, or a walk that throws away
 * every entry all look exactly like compliance. So every caller states the
 * size it expects to walk, pinned below the real count with headroom, and a
 * walk that comes back smaller throws instead of reporting a clean sweep.
 * The floor covers the walk; a guard that filters further is still on the
 * hook for a floor over its own narrowed set.
 *
 * ## What it returns
 *
 * Posix-separated paths relative to `root`, sorted, so a guard's output and
 * its failure message read the same on every platform. Directory entries are
 * dropped by the extension filter.
 *
 * ## What it does not do
 *
 * It applies no exclusions of its own — not `generated/`, not `__tests__`,
 * not `.test.ts`. Each guard states its own, because what counts as out of
 * scope is the guard's claim to make, not the walker's.
 *
 * And it must not be rooted at the repository root. Descending into
 * dot-prefixed directories is the whole point, but at the root that means
 * `.git` and — on a maintainer's machine mid-release — the `.wt-*` sibling
 * worktrees, each a full second copy of the tree that would double every
 * match. Every caller roots at `src/`, `e2e/` or a subtree of one.
 */
import { readdirSync } from "node:fs";
import { sep } from "node:path";

export function walkSourceFiles(
  root: string,
  options: { floor: number; extensions?: readonly string[] },
): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const files = readdirSync(root, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .filter((rel) => extensions.some((ext) => rel.endsWith(ext)))
    .sort();

  if (files.length < options.floor) {
    throw new Error(
      `walkSourceFiles(${root}) found ${files.length} file(s) matching ` +
        `${extensions.join(", ")}, below the stated floor of ${options.floor}. ` +
        `A sweep this small is a broken walk, not a clean tree — check the ` +
        `root before lowering the floor.`,
    );
  }
  return files;
}
