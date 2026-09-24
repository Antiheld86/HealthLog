/**
 * "Save & add another" keeps the report and the marker, clears the reading
 * (#1029).
 *
 * It used to clear the biomarker too. The picker then fell out of its
 * controlled state and went on showing the marker it last held while the
 * form's own value was empty, so the second save answered "Pick a biomarker
 * first" under a visibly picked marker. Keeping the marker removes the reset
 * that caused the disagreement; the picker itself is now always controlled,
 * so an empty pick shows the placeholder instead of a stale marker.
 */
import { describe, it, expect } from "vitest";

import { nextEntryAfterKeepOpen, type LabEntryDraft } from "../lab-form";

const saved: LabEntryDraft = {
  biomarkerId: "bm-vitamin-d",
  value: "42",
  valueText: "",
  takenAt: "2026-09-01T08:30",
  note: "fasting",
  sourceRange: "30 - 100",
  visitId: "visit-1",
};

describe("nextEntryAfterKeepOpen", () => {
  it("keeps the picked biomarker so the next save does not ask for it again", () => {
    expect(nextEntryAfterKeepOpen(saved).biomarkerId).toBe("bm-vitamin-d");
  });

  it("keeps what the report shares: its draw date and its visit", () => {
    const next = nextEntryAfterKeepOpen(saved);
    expect(next.takenAt).toBe("2026-09-01T08:30");
    expect(next.visitId).toBe("visit-1");
  });

  it("clears the reading itself and its printed window", () => {
    const next = nextEntryAfterKeepOpen({ ...saved, valueText: "negative" });
    expect(next.value).toBe("");
    expect(next.valueText).toBe("");
    expect(next.note).toBe("");
    expect(next.sourceRange).toBe("");
  });
});
