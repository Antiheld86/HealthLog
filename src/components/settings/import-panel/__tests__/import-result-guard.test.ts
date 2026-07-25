/**
 * #640 structural guard — "wrote nothing, looked successful" cannot come back.
 *
 * The classifier property in `import-result-state.test.ts` proves the rule.
 * This proves the rule is the only route to the affordance: the success icon
 * and the success colour exist in exactly one file in the import panel, on
 * exactly one key of the outcome table, and no card reaches for them
 * directly. A future card that hand-rolls a green tick fails here rather than
 * shipping and lying to a self-hoster about their sensor history.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PANEL_DIR = join(__dirname, "..");
const PRESENTATION_FILE = "import-result-view.tsx";

/** The success affordance: the tick component and the success colour token. */
const SUCCESS_MARKERS = ["CheckCircle2", "text-success"] as const;

function panelSourceFiles(): string[] {
  return readdirSync(PANEL_DIR).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
}

/** Code only — a comment naming the marker is prose, not an affordance. */
function readCode(name: string): string {
  return readFileSync(join(PANEL_DIR, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("import panel — success affordance is owned by the outcome table", () => {
  it("mentions the success markers in the presentation module only", () => {
    const offenders = panelSourceFiles()
      .filter((name) => name !== PRESENTATION_FILE)
      .filter((name) => {
        const source = readCode(name);
        return SUCCESS_MARKERS.some((marker) => source.includes(marker));
      });
    expect(offenders).toEqual([]);
  });

  it("binds each success marker to the success outcome inside that module", () => {
    const source = readCode(PRESENTATION_FILE);
    for (const marker of SUCCESS_MARKERS) {
      // Once as the lucide import (the tick only), once on the table row.
      const uses = source.split(marker).length - 1;
      expect(uses).toBe(marker === "CheckCircle2" ? 2 : 1);
    }
    // The table row itself: `success:` carries both markers, and no other
    // outcome key does.
    const successRow = source.match(/success:\s*\{[^}]*\}/)?.[0] ?? "";
    expect(successRow).toContain("CheckCircle2");
    expect(successRow).toContain("text-success");
    for (const other of ["partial", "failed", "empty"]) {
      const row = source.match(new RegExp(`${other}:\\s*\\{[^}]*\\}`))?.[0];
      expect(row).toBeTruthy();
      for (const marker of SUCCESS_MARKERS) {
        expect(row).not.toContain(marker);
      }
    }
  });

  it("routes every card's result line through the shared outcome line", () => {
    for (const name of [
      "csv-import-card.tsx",
      "json-import-card.tsx",
      "apple-health-import-card.tsx",
    ]) {
      expect(readCode(name)).toMatch(/CsvImportResultView|ImportOutcomeLine/);
    }
  });
});
