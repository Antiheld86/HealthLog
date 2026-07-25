import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InsightSectionCard } from "../insight-section-card";

const INSIGHTS_DIR = path.join(process.cwd(), "src/components/insights");

/**
 * The overview sections that compose the shared shell, by the `data-slot`
 * each one keeps. A section that drifts back onto a hand-rolled literal — or
 * a rename that silently drops one off the primitive — fails here instead of
 * surviving until the next audit.
 */
const MIGRATED_SLOTS = [
  "health-status-card",
  "breathing-screening-card",
  "coincident-deviation-card",
  "rhythm-events-card",
  "period-narrative-card",
  "labs-changes-card",
  "ecg-card",
  "daily-briefing",
];

/** The shell literal the primitive replaces. */
function paintsHandRolledShell(line: string): boolean {
  return (
    /className=/.test(line) &&
    /\bbg-card\b/.test(line) &&
    /\brounded-xl\b/.test(line) &&
    /\bborder\b/.test(line) &&
    /\bp-4 md:p-6\b/.test(line)
  );
}

function insightsSources(): { file: string; src: string }[] {
  return readdirSync(INSIGHTS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({
      file: f,
      src: readFileSync(path.join(INSIGHTS_DIR, f), "utf8"),
    }));
}

describe("<InsightSectionCard>", () => {
  it("composes Card with the pinned overview rhythm", () => {
    const html = renderToStaticMarkup(
      <InsightSectionCard>
        <p>body</p>
      </InsightSectionCard>,
    );
    expect(html).toContain('data-slot="insight-section-card"');
    expect(html).toContain('data-slot="card-content"');
    // Frame from the Card contract, body inset from CardContent.
    expect(html).toContain("bg-card");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("px-4");
    expect(html).toContain("md:px-6");
    // One inner rhythm — not the 8/12/16 px the copies had drifted to.
    expect(html).toContain("gap-3");
    expect(html).not.toContain("gap-2");
    expect(html).not.toContain("space-y-4");
  });

  it("takes a slot override and merges caller classes onto the frame", () => {
    const html = renderToStaticMarkup(
      <InsightSectionCard slot="rhythm-events-card" className="min-h-32">
        <p>body</p>
      </InsightSectionCard>,
    );
    expect(html).toContain('data-slot="rhythm-events-card"');
    expect(html).toContain("min-h-32");
    expect(html).not.toContain('data-slot="insight-section-card"');
  });

  it("flush drops the body inset for an edge-to-edge divided list", () => {
    const html = renderToStaticMarkup(
      <InsightSectionCard slot="labs-changes-card" flush className="divide-y">
        <div className="px-4 py-3">row</div>
      </InsightSectionCard>,
    );
    expect(html).toContain('data-slot="labs-changes-card"');
    expect(html).toContain("divide-y");
    // No CardContent wrapper — the rows own their own inset.
    expect(html).not.toContain('data-slot="card-content"');
    expect(html).toContain("py-0");
  });

  it("every migrated overview section renders through the primitive", () => {
    // Collapse whitespace so a prettier reflow onto multiple lines still
    // matches the `<InsightSectionCard slot="…"` opening.
    const sources = insightsSources()
      .map(({ src }) => src.replace(/\s+/g, " "))
      .join("\n");

    for (const slot of MIGRATED_SLOTS) {
      expect(
        sources,
        `${slot} should be rendered through <InsightSectionCard>`,
      ).toContain(`<InsightSectionCard slot="${slot}"`);
    }
  });

  it("no migrated section re-hand-rolls the card-shell literal", () => {
    const owners = insightsSources().filter(({ src }) =>
      MIGRATED_SLOTS.some((slot) => src.includes(`slot="${slot}"`)),
    );
    // Sanity: the scan actually found the files it means to guard.
    expect(owners.length).toBeGreaterThanOrEqual(7);

    const offenders = owners.flatMap(({ file, src }) =>
      src
        .split("\n")
        .filter(paintsHandRolledShell)
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
