/**
 * The pure state of the report scope picker.
 *
 * Kept out of the client component so the control shape is testable without a
 * DOM, and so the structural guard can import a lib module rather than reach
 * into a component. The panel owns layout and interaction; this owns "which
 * controls exist, what each one means, and what the scope line says".
 *
 * Only leaves are ever stored. A group's state is DERIVED from its leaves, so
 * a group and its leaves cannot disagree — there is no second source of truth
 * to reconcile.
 */
import {
  REPORT_GROUPS,
  SENSITIVE_GROUP_ID,
  leafLabelKey,
  type ReportGroupId,
  type ReportLeafId,
} from "./catalogue";

/** The panel's own state: the set of chosen leaf ids. */
export type PanelSelection = ReadonlySet<ReportLeafId>;

/** A group checkbox is on, off, or partly on. `mixed` is never a click target. */
export type GroupCheckState = "all" | "none" | "mixed";

/**
 * `leaves` is the group's leaves AS THE SURFACE RENDERS THEM, which is not
 * always the catalogue's: the share-link form hides the insurance leaf, and a
 * count or a check state computed over the full group would then describe
 * something the user cannot see or reach.
 */
export function groupCheckState(
  leaves: readonly ReportLeafId[],
  selected: PanelSelection,
): GroupCheckState {
  if (leaves.length === 0) return "none";
  const on = leaves.filter((leaf) => selected.has(leaf)).length;
  if (on === 0) return "none";
  if (on === leaves.length) return "all";
  return "mixed";
}

/** How many of the rendered leaves are chosen, and how many there are. */
export function groupCount(
  leaves: readonly ReportLeafId[],
  selected: PanelSelection,
): { on: number; total: number } {
  return {
    on: leaves.filter((leaf) => selected.has(leaf)).length,
    total: leaves.length,
  };
}

/** Toggle one leaf. */
export function toggleLeaf(
  selected: PanelSelection,
  leaf: ReportLeafId,
): Set<ReportLeafId> {
  const next = new Set(selected);
  if (next.has(leaf)) next.delete(leaf);
  else next.add(leaf);
  return next;
}

/**
 * Toggle a whole group.
 *
 * `mixed` and `none` both go to all-on; `all` goes to all-off. Turning a group
 * off and back on within one session restores the previous leaf pattern via
 * `remembered`, so the escape hatch does not cost the user their earlier
 * refinements. Across sessions only leaves persist and the group state is
 * re-derived.
 *
 * The fenced tier has no group control at all — `REPORT_GROUPS` still lists
 * it, but the panel renders no checkbox for it, and this function refuses it
 * so no future caller can route around that.
 */
export function toggleGroup(
  selected: PanelSelection,
  group: ReportGroupId,
  leaves: readonly ReportLeafId[],
  remembered?: PanelSelection,
): Set<ReportLeafId> {
  if (group === SENSITIVE_GROUP_ID) return new Set(selected);
  const next = new Set(selected);
  if (groupCheckState(leaves, selected) === "all") {
    for (const leaf of leaves) next.delete(leaf);
    return next;
  }
  const restore = remembered
    ? leaves.filter((leaf) => remembered.has(leaf))
    : [];
  for (const leaf of restore.length > 0 ? restore : leaves) next.add(leaf);
  return next;
}

/**
 * The scope line under the Generate button, as the parts a component renders.
 *
 * Fenced inclusions are always restated BY NAME, never folded into the count.
 * A number cannot be checked at a glance; "incl. Mood, PHQ-9" can, and the
 * reading is the consent check.
 */
export interface ScopeSummary {
  /** How many leaves are chosen in total. */
  total: number;
  /** How many groups contribute at least one leaf. */
  groups: number;
  /** i18n label keys for the chosen fenced leaves, in catalogue order. */
  sensitiveLabelKeys: string[];
}

export function scopeSummary(selected: PanelSelection): ScopeSummary {
  let total = 0;
  let groups = 0;
  const sensitiveLabelKeys: string[] = [];
  for (const group of REPORT_GROUPS) {
    const on = group.leaves.filter((leaf) => selected.has(leaf));
    if (on.length === 0) continue;
    groups += 1;
    total += on.length;
    if (group.id === SENSITIVE_GROUP_ID) {
      sensitiveLabelKeys.push(...on.map(leafLabelKey));
    }
  }
  return { total, groups, sensitiveLabelKeys };
}
