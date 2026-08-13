/**
 * The import cards' "docs" links must point at the external docs site.
 *
 * The app serves no `/docs` tree, so the old internal
 * `/docs/integrations/data-import` href 404'd for every user who
 * clicked it. The guide lives at `docs.healthlog.dev`; the link goes
 * through `INTEGRATION_DOCS_BASE` so the host lives in exactly one
 * place (the same constant every Settings → Integrations card uses).
 *
 * Watched red: restoring `href="/docs/integrations/data-import"` in
 * either card fails the matching assertion below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CARDS = ["csv-import-card.tsx", "json-import-card.tsx"] as const;

describe("import-card docs links", () => {
  for (const card of CARDS) {
    it(`${card} links the external docs site, never an internal /docs path`, () => {
      const source = readFileSync(join(__dirname, "..", card), "utf8");
      expect(source).not.toContain('href="/docs');
      expect(source).toContain("INTEGRATION_DOCS_BASE");
      expect(source).toContain("data-import");
      // External link hygiene for a new-tab docs jump.
      expect(source).toContain('rel="noopener noreferrer"');
    });
  }
});
