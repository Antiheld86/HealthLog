/**
 * The picker's pure state: derived group states, the group toggle, and the
 * scope line.
 *
 * Two properties are load-bearing beyond the panel. A group control must never
 * reach a fenced leaf, and the scope line must restate every fenced inclusion
 * by name rather than folding it into a count — that line is the consent check.
 *
 * Mutation checks:
 *   - remove the `SENSITIVE_GROUP_ID` early return in `toggleGroup` → "no group
 *     control can reach a fenced leaf" goes red.
 *   - drop the `sensitiveLabelKeys.push(...)` branch in `scopeSummary` → "the
 *     scope line names every fenced inclusion" goes red.
 *   - make `groupCheckState` return "all" when some leaves are on → "a partly
 *     selected group reads as mixed" goes red.
 */
import { describe, it, expect } from "vitest";

import {
  groupCheckState,
  groupCount,
  scopeSummary,
  toggleGroup,
  toggleLeaf,
} from "../panel-state";
import { REPORT_GROUPS, type ReportLeafId } from "../catalogue";

const vitals = REPORT_GROUPS.find((g) => g.id === "vitals")!;
const sensitive = REPORT_GROUPS.find((g) => g.id === "sensitive")!;

describe("scope picker state", () => {
  it("derives none / mixed / all from the leaves alone", () => {
    expect(groupCheckState(vitals.leaves, new Set())).toBe("none");
    expect(groupCheckState(vitals.leaves, new Set([vitals.leaves[0]]))).toBe(
      "mixed",
    );
    expect(groupCheckState(vitals.leaves, new Set(vitals.leaves))).toBe("all");
  });

  it("counts what is on against what the surface renders", () => {
    const count = groupCount(vitals.leaves, new Set([vitals.leaves[0]]));
    expect(count).toEqual({ on: 1, total: vitals.leaves.length });
  });

  it("counts against the RENDERED leaves, not the catalogue group", () => {
    // The share-link form hides the insurance leaf, so the identity group is
    // one leaf wide there. A count over the full group would tell the owner a
    // control covers something they cannot see or reach.
    const identity = REPORT_GROUPS.find((g) => g.id === "identity")!;
    const rendered = identity.leaves.filter((l) => l !== "INSURANCE");
    // The share-link form renders identity minus insurance: patient identity
    // and the emergency leaf. Selecting both is "all" of the rendered set even
    // though the catalogue group also carries the hidden insurance leaf.
    const selected = new Set<ReportLeafId>(["PATIENT_IDENTITY", "EMERGENCY"]);
    expect(groupCount(rendered, selected)).toEqual({ on: 2, total: 2 });
    expect(groupCheckState(rendered, selected)).toBe("all");
    // And the whole group, for contrast: insurance is unselected and hidden.
    expect(groupCount(identity.leaves, selected)).toEqual({ on: 2, total: 3 });
  });

  it("never adds a leaf the surface does not render", () => {
    const identity = REPORT_GROUPS.find((g) => g.id === "identity")!;
    const rendered = identity.leaves.filter((l) => l !== "INSURANCE");
    const after = toggleGroup(new Set<ReportLeafId>(), "identity", rendered);
    expect(after.has("PATIENT_IDENTITY")).toBe(true);
    expect(after.has("INSURANCE")).toBe(false);
  });

  it("turns a mixed group fully on, and a full group fully off", () => {
    const partial = new Set<ReportLeafId>([vitals.leaves[0]]);
    const on = toggleGroup(partial, "vitals", vitals.leaves);
    expect(groupCheckState(vitals.leaves, on)).toBe("all");
    const off = toggleGroup(on, "vitals", vitals.leaves);
    expect(groupCheckState(vitals.leaves, off)).toBe("none");
  });

  it("restores the previous pattern when a group comes back on", () => {
    const original = new Set<ReportLeafId>([
      vitals.leaves[0],
      vitals.leaves[1],
    ]);
    const off = toggleGroup(original, "vitals", vitals.leaves, original);
    const back = toggleGroup(off, "vitals", vitals.leaves, original);
    expect([...back].sort()).toEqual([...original].sort());
  });

  it("lets no group control reach a fenced leaf", () => {
    const before = new Set<ReportLeafId>();
    const after = toggleGroup(before, "sensitive", sensitive.leaves);
    expect([...after]).toEqual([]);
    for (const leaf of sensitive.leaves) {
      expect(after.has(leaf)).toBe(false);
    }
  });

  it("still lets a single fenced leaf be chosen one at a time", () => {
    const one = toggleLeaf(new Set<ReportLeafId>(), "MOOD");
    expect(one.has("MOOD")).toBe(true);
    expect(one.has("CYCLE")).toBe(false);
  });

  it("names every fenced inclusion in the scope line", () => {
    const summary = scopeSummary(new Set<ReportLeafId>(["WEIGHT", "MOOD"]));
    expect(summary.total).toBe(2);
    expect(summary.groups).toBe(2);
    expect(summary.sensitiveLabelKeys).toEqual(["reportSelection.leafMood"]);
  });

  it("says nothing is chosen when nothing is", () => {
    const summary = scopeSummary(new Set());
    expect(summary).toEqual({ total: 0, groups: 0, sensitiveLabelKeys: [] });
  });
});
