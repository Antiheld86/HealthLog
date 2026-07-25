/**
 * The resolved report selection: an inclusion list of leaf ids, and the only
 * three ways to mint one.
 *
 * Membership is inclusion. Absence is exclusion. There is no defaults constant
 * anywhere in this module, because a default that means "yes" is the defect
 * this shape exists to remove: the flat preferences object it replaces
 * resolved an absent key to "included", so a caller who sent nothing received
 * the whole record.
 *
 * The brand means a call site cannot hand `collectDoctorReportData` an object
 * literal. It has to go through one of the three minting functions below, and
 * those are the only place the version policy and the unknown-id policy live.
 */
import { z } from "zod/v4";

import { isReportLeafId, type ReportLeafId, ALL_LEAF_IDS } from "./catalogue";

declare const brand: unique symbol;

/** The stored/wire version. Bumped only when the leaf grammar itself changes. */
export const REPORT_SELECTION_VERSION = 2;

export interface ReportSelection {
  readonly [brand]: "report-selection";
  readonly version: typeof REPORT_SELECTION_VERSION;
  /** Whether this selection admits a leaf. The one question every gate asks. */
  has(leaf: ReportLeafId): boolean;
  /** The chosen leaves in catalogue order — for the audit row and scope line. */
  readonly leaves: readonly ReportLeafId[];
}

/** The wire shape of a selection, as sent and as stored. */
export const reportSelectionSchema = z
  .object({
    v: z.literal(REPORT_SELECTION_VERSION),
    leaves: z.array(z.string().min(1).max(64)).max(ALL_LEAF_IDS.length),
  })
  .strict();

export type ReportSelectionInput = z.infer<typeof reportSelectionSchema>;

const LEAF_ORDER = new Map<ReportLeafId, number>(
  ALL_LEAF_IDS.map((leaf, index) => [leaf, index]),
);

function mint(leaves: Iterable<ReportLeafId>): ReportSelection {
  const set = new Set<ReportLeafId>(leaves);
  const ordered = ALL_LEAF_IDS.filter((leaf) => set.has(leaf));
  return {
    version: REPORT_SELECTION_VERSION,
    has: (leaf: ReportLeafId) => set.has(leaf),
    leaves: ordered,
  } as unknown as ReportSelection;
}

/**
 * Mint from an explicit leaf list — the shipped template, the panel's own
 * state, and tests. Callers pass ids the compiler already checked.
 */
export function selectionFromLeaves(
  leaves: Iterable<ReportLeafId>,
): ReportSelection {
  return mint(leaves);
}

/** The empty selection: nothing chosen, so nothing is served. */
export const EMPTY_REPORT_SELECTION: ReportSelection = mint([]);

/** What went wrong parsing a request selection, for the 422 that names it. */
export interface SelectionRequestError {
  /** Leaf ids the caller sent that this build does not know. */
  unknownLeaves: string[];
}

/**
 * Mint from the Zod-parsed `selection` field of an API body.
 *
 * Unknown ids are REJECTED rather than dropped: a client sending an id the
 * server does not know is a contract mismatch the client has to see, and
 * dropping it would silently narrow a scope the caller did express.
 */
export function selectionFromRequest(
  input: ReportSelectionInput,
):
  | { ok: true; selection: ReportSelection }
  | { ok: false; error: SelectionRequestError } {
  const unknownLeaves = input.leaves.filter((leaf) => !isReportLeafId(leaf));
  if (unknownLeaves.length > 0) {
    return { ok: false, error: { unknownLeaves } };
  }
  return { ok: true, selection: mint(input.leaves as ReportLeafId[]) };
}

/**
 * Mint from a stored blob — a share link's frozen `sectionsJson` or the
 * owner's saved profile.
 *
 * Unknown ids are DROPPED and never added to: a leaf removed in a later
 * version simply stops being part of that selection. Anything that is not a
 * well-formed v2 blob resolves to the EMPTY selection, not to a default set —
 * a shape the server cannot read is not consent to anything. That is what
 * makes the legacy share links in migration 0273 revocable rather than
 * silently re-scoped.
 */
export function selectionFromStoredBlob(raw: unknown): ReportSelection {
  const parsed = reportSelectionSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_REPORT_SELECTION;
  return mint(parsed.data.leaves.filter(isReportLeafId));
}

/** Serialise a selection to the stored / wire shape. */
export function selectionToBlob(
  selection: ReportSelection,
): ReportSelectionInput {
  return { v: REPORT_SELECTION_VERSION, leaves: [...selection.leaves] };
}

/** Whether this selection admits nothing at all. */
export function isEmptySelection(selection: ReportSelection): boolean {
  return selection.leaves.length === 0;
}

/** Stable ordering helper, exported for the panel's own state folding. */
export function orderLeaves(
  leaves: Iterable<ReportLeafId>,
): readonly ReportLeafId[] {
  return [...new Set(leaves)].sort(
    (a, b) => (LEAF_ORDER.get(a) ?? 0) - (LEAF_ORDER.get(b) ?? 0),
  );
}
