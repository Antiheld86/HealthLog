import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const MOOD_LIST = join(__dirname, "../../../mood/mood-list.tsx");
/**
 * The two modules the mood insights surface is rendered from. The breakdown
 * cluster lives behind `next/dynamic` in its own file; both are the surface.
 */
const INSIGHTS_SURFACE_FILES = [
  join(COMPONENT_DIR, "mood-insights-sections.tsx"),
  join(COMPONENT_DIR, "mood-insights-breakdowns.tsx"),
];

/**
 * v1.8.6 — the notes timeline display is removed from the mood insights
 * surface (note capture on the form stays). These structural guards keep
 * the surface from regressing back to a notes feed and keep long notes
 * truncated in the entries table.
 */
describe("mood notes timeline removal", () => {
  it("deletes the notes-timeline component file", () => {
    expect(existsSync(join(COMPONENT_DIR, "mood-notes-timeline.tsx"))).toBe(
      false,
    );
  });

  it("no longer renders the notes timeline from the insights sections", () => {
    // Both halves of the surface: the eager module that paints the calendar
    // and the assessment, and the deferred module that carries every
    // breakdown. A guard reading only one of them would go quiet the moment
    // the other grew a notes feed.
    for (const file of INSIGHTS_SURFACE_FILES) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("MoodNotesTimeline");
      expect(src).not.toContain("notesTimeline");
      expect(src).not.toContain("notesTimelineTitle");
    }
  });

  it("mounts the narrative feed in the insights sections", () => {
    // v1.12.7 — the narrative one-liners now ride the merged "What stands out"
    // card (`MoodWhatStandsOut`), which renders `MoodNarrativeFeed` internally.
    // The structural guard tracks the mount point on the sections surface.
    //
    // v1.38 — that mount point moved into `mood-insights-breakdowns.tsx` when
    // the below-the-fold cluster went behind `next/dynamic`. Read as the union
    // of the two files, so the guard asserts the card is mounted SOMEWHERE on
    // the surface rather than in one particular file — which is what it was
    // always about.
    const src = INSIGHTS_SURFACE_FILES.map((f) => readFileSync(f, "utf8")).join(
      "\n",
    );
    expect(src).toContain("MoodWhatStandsOut");
    expect(src).toContain("MoodInTargetTile");
  });

  it("renders the narrative feed inside the merged what-stands-out card", () => {
    const src = readFileSync(
      join(COMPONENT_DIR, "mood-what-stands-out.tsx"),
      "utf8",
    );
    expect(src).toContain("MoodNarrativeFeed");
    expect(src).toContain("MoodDiscoveredRelations");
  });
});

describe("mood entries table — long-note truncation", () => {
  const src = readFileSync(MOOD_LIST, "utf8");

  it("caps the note column width to prevent horizontal scroll", () => {
    expect(src).toContain("max-w-[18rem]");
  });

  it("clamps the note by default and exposes the full text via the row toggle", () => {
    // v1.16.8 — the desktop hover tooltip is replaced by an expandable
    // toggle (works on touch, preserves line breaks via pre-wrap). The
    // default presentation stays clamped so the table keeps its density.
    expect(src).toContain("line-clamp-2");
    expect(src).toContain("mood-note-toggle");
    expect(src).toContain("whitespace-pre-wrap");
    expect(src).not.toContain("TooltipContent");
  });
});
