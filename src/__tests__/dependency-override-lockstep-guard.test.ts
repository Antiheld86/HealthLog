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
 * The matcher had a blind spot of its own until 2026-09-02: it refused any
 * workspace key beginning with `@`, so every scoped package was invisible to
 * it. `@hono/node-server` was pinned on one side and unpinned on the other and
 * the guard stayed green, which is the same shape of green the guard exists to
 * prevent. Scoped keys parse now, and a test below pins that they do.
 *
 * Limit, written down so the next reader does not over-trust a green run: this
 * compares declared ranges. It cannot see a NEW vulnerable transitive that
 * neither file mentions. Only the image scan can, and that job runs on
 * main-push, not on pull requests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const WORKSPACE = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");

/** `npm pkg set 'overrides.<name>=<range>'` occurrences in the Dockerfile. */
function dockerfileOverrides(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /npm\s+pkg\s+set\s+['"]overrides\.([^='"]+)=([^'"]+)['"]/g;
  for (const match of DOCKERFILE.matchAll(pattern)) {
    found.set(match[1].trim(), match[2].trim());
  }
  return found;
}

/**
 * Reduces an overrides key to the bare package name. The key carries a version
 * selector, so `deepmerge-ts@<8.0.0` and a bare `deepmerge-ts` both land on the
 * same name. A scoped name opens with its own `@`, so the selector starts at
 * the SECOND one, not the first.
 */
function packageNameOf(key: string): string {
  const trimmed = key.trim();
  const selectorAt = trimmed.startsWith("@")
    ? trimmed.indexOf("@", 1)
    : trimmed.indexOf("@");
  return (selectorAt === -1 ? trimmed : trimmed.slice(0, selectorAt)).trim();
}

/**
 * `"<name>@<selector>": "<range>"` entries under the workspace `overrides:`
 * block.
 */
function workspaceOverrides(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /^\s+"([^"]+)"\s*:\s*"([^"]+)"/gm;
  const block = WORKSPACE.split(/^allowBuilds:/m)[0];
  for (const match of block.matchAll(pattern)) {
    found.set(packageNameOf(match[1]), match[2].trim());
  }
  return found;
}

describe("dependency overrides — pnpm workspace and the npm install agree", () => {
  it("finds the Dockerfile's npm-side overrides at all", () => {
    const docker = dockerfileOverrides();
    // A zero-match regex would make every assertion below vacuously true.
    // This is the check that keeps the guard honest about its own matcher.
    expect(docker.size).toBeGreaterThan(0);
    expect(docker.has("deepmerge-ts")).toBe(true);
  });

  it("finds the workspace overrides at all", () => {
    const workspace = workspaceOverrides();
    expect(workspace.size).toBeGreaterThan(0);
    expect(workspace.has("deepmerge-ts")).toBe(true);
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

    const workspace = workspaceOverrides();
    const scoped = [...workspace.keys()].filter((name) => name.startsWith("@"));
    expect(scoped.length).toBeGreaterThan(0);
  });

  it("pins the same range wherever both files name the same package", () => {
    const docker = dockerfileOverrides();
    const workspace = workspaceOverrides();

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
    const docker = dockerfileOverrides();
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
    const range = dockerfileOverrides().get("deepmerge-ts");
    expect(range).toBeDefined();
    expect(range).toMatch(/\^?8\./);
  });
});
