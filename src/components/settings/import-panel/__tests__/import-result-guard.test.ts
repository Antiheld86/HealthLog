/**
 * #640 structural guard — "wrote nothing, looked successful" cannot come back.
 *
 * The classifier property in `import-result-state.test.ts` proves the rule.
 * This proves the rule is the only route to the affordance: the success icon
 * and the success colour exist in exactly one file in the import panel, on
 * exactly one key of the outcome table, and no card reaches for them
 * directly. A future card that hand-rolls a green tick fails here rather than
 * shipping and lying to a self-hoster about their sensor history.
 *
 * #650 widened it. The medication intake import is a third import surface, in
 * another directory, and it was not covered when the rule landed — it kept its
 * own success/error tone and reported a run that wrote one row out of
 * twenty-eight as a success. "Every import surface" now means every one of
 * them, listed by path, so a fourth surface has to be added here deliberately
 * rather than inheriting the old behaviour by being somewhere else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PANEL_DIR = join(__dirname, "..");
const PRESENTATION_FILE = "import-result-view.tsx";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

/**
 * Every surface that reports an import result, and the module each one must
 * render its outcome through. Paths from the repository root.
 */
const IMPORT_SURFACES: ReadonlyArray<{ path: string; through: RegExp }> = [
  {
    path: "src/components/settings/import-panel/csv-import-card.tsx",
    through: /CsvImportResultView|ImportOutcomeLine/,
  },
  {
    path: "src/components/settings/import-panel/json-import-card.tsx",
    through: /CsvImportResultView|ImportOutcomeLine/,
  },
  {
    path: "src/components/settings/import-panel/apple-health-import-card.tsx",
    through: /CsvImportResultView|ImportOutcomeLine/,
  },
  {
    path: "src/components/medications/intake-import-result.tsx",
    through: /ImportOutcomeLine/,
  },
  {
    path: "src/components/medications/intake-import-dialog.tsx",
    through: /IntakeImportResultView/,
  },
  {
    path: "src/components/settings/import-panel/dose-history-import-card.tsx",
    through: /IntakeImportResultView/,
  },
  {
    path: "src/components/settings/import-panel/dose-history-verdict.tsx",
    through: /IntakeImportSkipGroups/,
  },
];

/** The success affordance: the tick component and the success colour token. */
const SUCCESS_MARKERS = ["CheckCircle2", "text-success"] as const;

function panelSourceFiles(): string[] {
  return readdirSync(PANEL_DIR).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
}

/** Code only — a comment naming the marker is prose, not an affordance. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function readCode(name: string): string {
  return stripComments(readFileSync(join(PANEL_DIR, name), "utf8"));
}

function readRepoCode(relativePath: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, relativePath), "utf8"));
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

  it("routes every import surface's result line through the shared outcome line", () => {
    for (const surface of IMPORT_SURFACES) {
      expect(
        readRepoCode(surface.path),
        `${surface.path} must render its outcome through the shared line`,
      ).toMatch(surface.through);
    }
  });

  it("keeps the success markers out of every import surface", () => {
    const offenders = IMPORT_SURFACES.filter((surface) =>
      SUCCESS_MARKERS.some((marker) =>
        readRepoCode(surface.path).includes(marker),
      ),
    ).map((surface) => surface.path);
    expect(
      offenders,
      offenders.length > 0
        ? `Import surface(s) hand-rolling the success affordance instead of ` +
            `classifying the counts: ${offenders.join(", ")}`
        : undefined,
    ).toEqual([]);
  });
});
