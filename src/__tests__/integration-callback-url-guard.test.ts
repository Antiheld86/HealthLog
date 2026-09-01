/**
 * Structural guard: no client module on the Settings → Integrations surface
 * may read `process.env.NEXT_PUBLIC_APP_URL`.
 *
 * Why this is a tripwire and not a behavioural test. Next.js inlines every
 * `NEXT_PUBLIC_*` reference in a `"use client"` module at BUILD time. The
 * published image is built without `NEXT_PUBLIC_APP_URL` (the Dockerfile
 * passes only the version / build-sha / built-at args, and `.env` files are
 * not in the build context), so any such read compiles to `undefined` for
 * every self-hoster, no matter what their runtime env says. A unit test with
 * the variable set in `process.env` cannot see that: under Vitest the read is
 * live, so the code passes while the shipped bundle is inert. v1.38.0's
 * callback-origin notice shipped exactly that way.
 *
 * The callback URL therefore comes from the server (`getIntegrationCallbackUrls`
 * in `src/lib/integrations/callback-urls.ts`) and travels down as a prop. This
 * guard fails the moment a client file on the surface reaches for the env var
 * again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SURFACE = join(process.cwd(), "src/components/settings/integrations");

const CLIENT_DIRECTIVE = /^\s*["']use client["']\s*;?/m;
const APP_URL_READ = /process\.env\.NEXT_PUBLIC_APP_URL/;

function surfaceFiles(): string[] {
  return walkSourceFiles(SURFACE, { floor: 15 })
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
}

describe("Settings → Integrations client modules never read NEXT_PUBLIC_APP_URL", () => {
  it('every "use client" file on the surface is free of the env read', () => {
    const files = surfaceFiles();
    const clientFiles = files.filter((rel) =>
      CLIENT_DIRECTIVE.test(readFileSync(join(SURFACE, rel), "utf8")),
    );
    // The walk must have found the surface, and the surface must still be
    // client-rendered — an empty set would pass on a tree the guard never read.
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(clientFiles.length).toBeGreaterThanOrEqual(10);

    const offenders = clientFiles.filter((rel) =>
      APP_URL_READ.test(readFileSync(join(SURFACE, rel), "utf8")),
    );
    expect(
      offenders,
      `NEXT_PUBLIC_APP_URL is inlined at build time in client bundles and is empty in the published image; pass the server-derived callback URL as a prop instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
