import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Root layout — i18n boot-script ordering pin.
 *
 * The locale catalog is a ~370 KB separate asset, and the client bundle
 * needs it in hand for its FIRST render or `t()` resolves raw keys against
 * the server's real text (React error #418, plus a visible frame of
 * `nav.skipToContent` before the provider backfills).
 *
 * A plain `<script defer>` cannot deliver that. Next emits its own chunks
 * as `async` tags AHEAD of anything the layout renders into `<head>`, and
 * an `async` script executes the moment its fetch settles — so the catalog
 * was racing the app bundle and lost about a third of cold loads.
 * `next/script` at `beforeInteractive` is the only registration Next
 * awaits before requiring an app module, so it is the one that holds.
 *
 * This is a structural pin: reverting the tag to `<script defer>` reads
 * like a harmless simplification and its damage is intermittent.
 */
const LAYOUT_PATH = join(process.cwd(), "src/app/layout.tsx");

describe("root layout — i18n boot script", () => {
  const src = readFileSync(LAYOUT_PATH, "utf8");

  it("registers the catalog through next/script", () => {
    expect(src).toContain('from "next/script"');
    const tag = src.slice(src.indexOf("<Script"));
    expect(tag).toContain('strategy="beforeInteractive"');
    expect(tag).toContain("/i18n/${initialLocale}.js");
  });

  it("carries the CSP nonce", () => {
    const tag = src.slice(
      src.indexOf("<Script"),
      src.indexOf("/>", src.indexOf("<Script")),
    );
    expect(tag).toContain("nonce={nonce}");
  });

  it("never falls back to a bare deferred script tag for the catalog", () => {
    const bareTag = /<script\b[^>]*\/i18n\//;
    expect(bareTag.test(src)).toBe(false);
  });
});
