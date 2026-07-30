/**
 * The service worker's fallback version must equal the release version.
 *
 * `public/sw.js` derives its cache names from `self.__APP_VERSION__`, injected by
 * `public/sw-version.js`, which `scripts/generate-sw-version.mjs` writes from
 * `package.json` on every prebuild. When `importScripts('/sw-version.js')`
 * fails, the SW falls back to a literal compiled into `sw.js` behind the
 * `@sw-version-fallback` anchor, and the same prebuild step rewrites that
 * literal too.
 *
 * Two places therefore declare one version, and until this file existed nothing
 * made them agree. `scripts/__tests__/generate-sw-version.test.ts` checks the
 * GENERATED file against `package.json`; the behavioural suite in
 * `service-worker.test.ts` reads the fallback literal out of the source so its
 * cache-name assertions "never drift from the literal it is exercising". Both
 * are reasonable in isolation and together they leave the literal unchecked: a
 * release whose version was bumped without a rebuild ships a fallback pointing
 * at the PREVIOUS release, and every test stays green.
 *
 * The consequence is small but real, and it only bites on the degraded path. A
 * client that cannot load `/sw-version.js` computes last release's cache names,
 * so it keeps serving the previous shell and its cleanup step treats the current
 * caches as the stale ones.
 *
 * This is a one-line equality, which makes it a gate rather than a review aid.
 * Failing it means the tree needs a rebuild before it is committed, which is
 * exactly the step whose absence caused the drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function swFallbackVersion(): string {
  const source = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  const match = /\/\* @sw-version-fallback \*\/\s*"(v[^"]*)"/.exec(source);
  if (!match) {
    throw new Error(
      "no @sw-version-fallback anchor in public/sw.js — the prebuild generator keys on it",
    );
  }
  return match[1];
}

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const version = pkg.version;
  if (typeof version !== "string") {
    throw new Error("package.json carries no string version");
  }
  return version;
}

describe("the service-worker fallback version is anchored to the release", () => {
  it("matches package.json", () => {
    expect(swFallbackVersion()).toBe(`v${packageVersion()}`);
  });
});
