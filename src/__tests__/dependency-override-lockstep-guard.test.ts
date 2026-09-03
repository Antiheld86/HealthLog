/**
 * The two override mechanisms agree, or the build fails here.
 *
 * The image carries two independent installs. `pnpm install` builds the app
 * tree and honours the `overrides` block in `pnpm-workspace.yaml`. A second,
 * npm-owned install builds `/opt/prisma-cli` (Dockerfile) and honours nothing
 * from that file — it reads its own `overrides` field instead.
 *
 * On 2026-08-21 only the first one was set. The dependency audit over the app
 * tree passed, and the Trivy image scan reported CVE-2026-40345 against
 * `deepmerge-ts@7.1.5` under `/opt/prisma-cli`, pulled in by
 * `prisma -> @prisma/config`. A pin that covers one of two installs reads
 * exactly like a pin that covers both, right up until something scans the
 * artefact rather than the lockfile.
 *
 * So: every package pinned in BOTH places must be pinned to the same range,
 * and the Dockerfile's pin must survive as long as the workspace one does.
 * This does NOT assert that every workspace override is mirrored — most exist
 * for packages `/opt/prisma-cli` never installs, and demanding a mirror there
 * would encode noise. It asserts agreement where both files speak, which is
 * the failure that actually happened.
 *
 * The matcher has now been widened twice, and both widenings were the same
 * class of hole: a spelling the files accept and the regex did not.
 *
 *   - 2026-09-02: the workspace side refused any key beginning with `@`, so
 *     every scoped package was invisible. `@hono/node-server` was pinned on
 *     one side and unpinned on the other and the guard stayed green.
 *   - 2026-09-03: the workspace side demanded a QUOTED key, and the Dockerfile
 *     side demanded the exact spelling `npm pkg set 'overrides.X=Y'`. Every
 *     entry in the file happens to carry an `@<selector>` suffix, which needs
 *     quoting, so the matcher looked complete — but `mysql2: "^3.22.0"` is a
 *     legal pnpm override with no selector and no quotes, and it parsed to
 *     nothing. Unquoting that key and pointing the Dockerfile at `^1.0.0`
 *     left all six tests green.
 *
 * Both sides now parse line by line and collect what they could NOT read into
 * an `unparsed` list, which is asserted empty. A future spelling neither
 * matcher knows fails the guard loudly instead of shrinking the compared set
 * in silence, which is the only structural defence against a third repeat.
 *
 * Limits, written down so the next reader does not over-trust a green run:
 * this compares DECLARED ranges. It cannot see a NEW vulnerable transitive
 * that neither file mentions — only the image scan can, and that job runs on
 * main-push, not on pull requests. It also reads the Dockerfile as text, so a
 * pin injected by a build ARG, an `npm config` call, or a package.json copied
 * in from elsewhere is outside both matchers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const WORKSPACE = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");

/** What a side of the comparison parsed, and what it had to give up on. */
type ParsedOverrides = {
  /** Bare package name → declared range. */
  pins: Map<string, string>;
  /** Lines that name an override but no matcher could read. */
  unparsed: string[];
};

/**
 * Reduces an overrides key to the bare package name. The key MAY carry a
 * version selector, so `deepmerge-ts@<8.0.0` and a bare `deepmerge-ts` both
 * land on the same name. A scoped name opens with its own `@`, so the selector
 * starts at the SECOND one, not the first.
 */
function packageNameOf(key: string): string {
  const trimmed = key.trim();
  const selectorAt = trimmed.startsWith("@")
    ? trimmed.indexOf("@", 1)
    : trimmed.indexOf("@");
  return (selectorAt === -1 ? trimmed : trimmed.slice(0, selectorAt)).trim();
}

/** Strips one layer of matching YAML/shell quotes, if present. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

/**
 * Splits one `<key>: <value>` mapping line. A QUOTED key may itself contain a
 * colon, so the separator is looked for after the closing quote; an unquoted
 * key cannot contain one, so the first colon is the separator.
 */
function splitMapping(line: string): [string, string] | null {
  const body = line.trim();
  const quote = body.startsWith('"') ? '"' : body.startsWith("'") ? "'" : null;
  if (quote) {
    const close = body.indexOf(quote, 1);
    if (close === -1) return null;
    const rest = body.slice(close + 1).trimStart();
    if (!rest.startsWith(":")) return null;
    return [body.slice(0, close + 1), rest.slice(1)];
  }
  const colon = body.indexOf(":");
  if (colon === -1) return null;
  return [body.slice(0, colon), body.slice(colon + 1)];
}

/** Reads a YAML scalar value, dropping any trailing `# comment`. */
function scalarValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"/.exec(trimmed) ?? /^'([^']*)'/.exec(trimmed);
  if (quoted) return quoted[1];
  return trimmed.split(/\s+#/)[0].trim();
}

/**
 * Entries under the workspace `overrides:` block.
 *
 * pnpm accepts the key with or without a version selector and YAML accepts
 * either half quoted or bare, so all four spellings below are the same pin and
 * all four must parse:
 *
 *   "mysql2@<3.22.0": "^3.22.0"
 *   mysql2@<3.22.0: ^3.22.0
 *   "mysql2": "^3.22.0"
 *   mysql2: ^3.22.0
 */
export function parseWorkspaceOverrides(yaml: string): ParsedOverrides {
  const pins = new Map<string, string>();
  const unparsed: string[] = [];
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (start === -1) {
    return { pins, unparsed: ["no `overrides:` block found"] };
  }

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    // A line at column zero is the next top-level key; the block ends there.
    if (!/^\s/.test(line)) break;
    if (/^\s*#/.test(line)) continue;

    const mapping = splitMapping(line);
    const range = mapping ? scalarValue(mapping[1]) : "";
    if (!mapping || range === "") {
      unparsed.push(line.trim());
      continue;
    }
    pins.set(packageNameOf(unquote(mapping[0])), range);
  }
  return { pins, unparsed };
}

/**
 * `overrides` entries written into `/opt/prisma-cli/package.json`.
 *
 * `npm pkg set` is indifferent to shell quoting, so the assignment may be
 * quoted whole, quoted per half, or bare. Any non-comment Dockerfile line that
 * names `overrides` and matches none of the accepted spellings is reported as
 * unparsed rather than skipped — that is what stops a fresh spelling from
 * quietly shrinking the compared set.
 */
export function parseDockerfileOverrides(dockerfile: string): ParsedOverrides {
  const pins = new Map<string, string>();
  const unparsed: string[] = [];

  // `npm pkg set 'overrides.<name>=<range>'`, `"overrides.<name>=<range>"`,
  // `overrides.<name>=<range>`, and the per-half-quoted variants. A package
  // name and a semver range never contain a quote character, so quoting is
  // pure shell decoration here: strip it and every spelling collapses onto the
  // same `overrides.<name>=<range>` token.
  const npmPkgSet = /npm\s+pkg\s+set\s+overrides\.([^\s=]+)\s*=\s*([^\s&;|]+)/;
  // A raw JSON field, e.g. inside a `cat > package.json` heredoc:
  // `"<name>": "<range>"` on a line under an `"overrides"` key.
  const jsonField = /"([^"]+)"\s*:\s*"([^"]+)"/;

  let insideJsonOverrides = false;
  for (const rawLine of dockerfile.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;

    if (insideJsonOverrides) {
      if (line.startsWith("}")) {
        insideJsonOverrides = false;
        continue;
      }
      const field = jsonField.exec(line);
      if (field) {
        pins.set(packageNameOf(field[1]), field[2].trim());
        continue;
      }
      unparsed.push(line);
      continue;
    }

    if (!/\boverrides\b/.test(line)) continue;

    if (/"overrides"\s*:\s*\{\s*$/.test(line)) {
      insideJsonOverrides = true;
      continue;
    }

    const set = npmPkgSet.exec(line.replace(/['"]/g, ""));
    if (set) {
      pins.set(packageNameOf(set[1]), set[2].trim());
      continue;
    }
    unparsed.push(line);
  }
  return { pins, unparsed };
}

const dockerfileOverrides = () => parseDockerfileOverrides(DOCKERFILE);
const workspaceOverrides = () => parseWorkspaceOverrides(WORKSPACE);

describe("dependency overrides — pnpm workspace and the npm install agree", () => {
  it("finds the Dockerfile's npm-side overrides at all", () => {
    const docker = dockerfileOverrides();
    // A zero-match regex would make every assertion below vacuously true.
    // This is the check that keeps the guard honest about its own matcher.
    expect(docker.pins.size).toBeGreaterThan(0);
    expect(docker.pins.has("deepmerge-ts")).toBe(true);
  });

  it("finds the workspace overrides at all", () => {
    const workspace = workspaceOverrides();
    expect(workspace.pins.size).toBeGreaterThan(0);
    expect(workspace.pins.has("deepmerge-ts")).toBe(true);
  });

  it("refuses an overrides line it could not read on either side", () => {
    // The failure this replaces: a matcher that silently narrows the compared
    // set is indistinguishable from a matcher that found agreement. Anything
    // neither spelling table covers has to surface here.
    expect(
      workspaceOverrides().unparsed,
      "pnpm-workspace.yaml has an `overrides:` entry this guard cannot read. " +
        "Teach `parseWorkspaceOverrides` the spelling — do not leave it " +
        "unparsed, or the pin stops being compared against the Dockerfile.",
    ).toEqual([]);
    expect(
      dockerfileOverrides().unparsed,
      "The Dockerfile names `overrides` on a line this guard cannot read. " +
        "Teach `parseDockerfileOverrides` the spelling — an unread pin is an " +
        "uncompared pin.",
    ).toEqual([]);
  });

  it("reads scoped workspace keys rather than skipping them", () => {
    // The old matcher started the name at `[^"@]`, so `@hono/node-server` was
    // never in the shared set and could disagree across the two files without
    // failing anything. Both halves are asserted: the reduction itself, and
    // that a real scoped entry survives it.
    expect(packageNameOf("@hono/node-server@<1.19.15")).toBe(
      "@hono/node-server",
    );
    expect(packageNameOf("dompurify@<3.4.13")).toBe("dompurify");
    expect(packageNameOf("js-yaml@>=4.0.0 <4.3.1")).toBe("js-yaml");
    expect(packageNameOf("deepmerge-ts")).toBe("deepmerge-ts");

    const scoped = [...workspaceOverrides().pins.keys()].filter((name) =>
      name.startsWith("@"),
    );
    expect(scoped.length).toBeGreaterThan(0);
  });

  it("reads a workspace pin that carries no selector and no quotes", () => {
    // `mysql2: "^3.22.0"` is a valid pnpm override and valid YAML. The old
    // matcher required a quoted key, so it parsed to nothing — and because
    // every entry in the file happens to need quoting for its selector, the
    // hole was invisible by inspection. All four spellings are one pin.
    const parsed = parseWorkspaceOverrides(
      [
        "overrides:",
        "  # a comment inside the block",
        '  "quoted-selector@<2.0.0": "^2.0.0"',
        "  bare-selector@<2.0.0: ^2.0.0",
        '  "quoted-plain": "^2.0.0"',
        "  bare-plain: ^2.0.0",
        '  "@scoped/bare-value@<2.0.0": ^2.0.0',
        "  trailing-comment: ^2.0.0 # note",
        "",
        "allowBuilds:",
        "  prisma: true",
      ].join("\n"),
    );

    expect(parsed.unparsed).toEqual([]);
    expect(Object.fromEntries(parsed.pins)).toEqual({
      "quoted-selector": "^2.0.0",
      "bare-selector": "^2.0.0",
      "quoted-plain": "^2.0.0",
      "bare-plain": "^2.0.0",
      "@scoped/bare-value": "^2.0.0",
      "trailing-comment": "^2.0.0",
    });
    // The block ends at the next top-level key: `allowBuilds` is not a pin.
    expect(parsed.pins.has("prisma")).toBe(false);
  });

  it("reads every spelling of the Dockerfile's npm-side pin", () => {
    // The old matcher accepted `npm pkg set 'overrides.X=Y'` and nothing else,
    // so re-quoting the same line removed the pin from the comparison without
    // changing what the image installs.
    const parsed = parseDockerfileOverrides(
      [
        "# a comment mentioning the `overrides` block",
        "RUN npm init -y && \\",
        "    npm pkg set 'overrides.single-quoted=^1.0.0' && \\",
        '    npm pkg set "overrides.double-quoted=^1.0.0" && \\',
        "    npm pkg set overrides.unquoted=^1.0.0 && \\",
        "    npm pkg set 'overrides.@scoped/split'='^1.0.0' && \\",
        "    npm install --omit=dev prisma@7.8.0",
      ].join("\n"),
    );

    expect(parsed.unparsed).toEqual([]);
    expect(Object.fromEntries(parsed.pins)).toEqual({
      "single-quoted": "^1.0.0",
      "double-quoted": "^1.0.0",
      unquoted: "^1.0.0",
      "@scoped/split": "^1.0.0",
    });
  });

  it("reports an overrides spelling neither matcher knows", () => {
    // Written so the refusal itself is proven, not assumed. A guard that
    // cannot fail is the failure mode this file exists to close.
    expect(
      parseWorkspaceOverrides(["overrides:", "  - not-a-mapping"].join("\n"))
        .unparsed,
    ).toEqual(["- not-a-mapping"]);
    expect(
      parseDockerfileOverrides("RUN node -e \"pkg.overrides['x']='^1.0.0'\"")
        .unparsed.length,
    ).toBeGreaterThan(0);
  });

  it("pins the same range wherever both files name the same package", () => {
    const docker = dockerfileOverrides().pins;
    const workspace = workspaceOverrides().pins;

    const shared = [...docker.keys()].filter((name) => workspace.has(name));
    expect(shared.length).toBeGreaterThan(0);

    for (const name of shared) {
      expect(
        docker.get(name),
        `Dockerfile pins ${name} to ${docker.get(name)} while ` +
          `pnpm-workspace.yaml pins it to ${workspace.get(name)}. The image ` +
          `carries both installs, so the looser of the two is what ships.`,
      ).toBe(workspace.get(name));
    }
  });

  it("mirrors every pin the /opt/prisma-cli tree was scanned on", () => {
    // These three were each reported by the image scan under
    // `/opt/prisma-cli`, reached through `prisma`. Losing a mirror is not a
    // style regression, it is the vulnerable version coming back.
    const docker = dockerfileOverrides().pins;
    for (const name of ["deepmerge-ts", "@hono/node-server", "valibot"]) {
      expect(
        docker.has(name),
        `${name} was flagged under /opt/prisma-cli and needs an ` +
          `\`npm pkg set 'overrides.${name}=...'\` line in the Dockerfile; ` +
          `pnpm-workspace.yaml does not reach that install.`,
      ).toBe(true);
    }
  });

  it("keeps the override ahead of the version Prisma's config asks for", () => {
    // `@prisma/config` requests deepmerge-ts 7.x; the advisory is fixed in
    // 8.0.0. Anything that lets a 7.x back in re-opens CVE-2026-40345.
    const range = dockerfileOverrides().pins.get("deepmerge-ts");
    expect(range).toBeDefined();
    expect(range).toMatch(/\^?8\./);
  });
});
