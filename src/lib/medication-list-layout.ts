/**
 * Medications list presentation — persisted in
 * `User.medicationListLayoutJson`.
 *
 * Single source of truth for the /medications view choice (cards vs the
 * compact table) and the user-defined manual medication order shared by
 * BOTH views. Null / missing column = the defaults below; the GET
 * endpoint never lazy-writes a row, so the column only carries data once
 * the user has explicitly toggled the view or saved an order.
 *
 * Mirrors `insights-layout.ts` / `dashboard-layout.ts` — same separate
 * per-surface column on `User`, same resolver / serializer semantics,
 * same preserve-when-absent PUT contract (see the route).
 */

/** The two list presentations /medications can render. */
export const MEDICATION_LIST_VIEWS = ["cards", "table"] as const;

export type MedicationListView = (typeof MEDICATION_LIST_VIEWS)[number];

export interface MedicationListLayout {
  version: 1;
  /** Which presentation the list renders in. Default: cards. */
  view: MedicationListView;
  /**
   * User-defined manual medication order (medication ids, first = top).
   * Applied to BOTH views; medications not in the list append after the
   * ordered block in the alphabetical default order. Ids that no longer
   * resolve to a medication are ignored at apply time (a deleted
   * medication must not 422 the stored layout), so the list is bounded
   * but not ownership-validated — it is display-only.
   */
  order: string[];
}

/**
 * Upper bound on the persisted order list. Generous — the medications
 * list itself has no hard cap, but the blob must stay small; beyond
 * this many entries the tail falls back to the alphabetical default.
 */
/**
 * v1.32.21 (R5a) — the resolved presentation plus the server-stamped
 * `updatedAt` optimistic-concurrency token (mirrors `User.updatedAt`, never
 * persisted inside the blob). GET and every write response carry it; the
 * client echoes it back as `baseUpdatedAt` on the next write. Mirrors
 * `DashboardLayoutWithToken` / `InsightsLayoutWithToken`.
 */
export type MedicationListLayoutWithToken = MedicationListLayout & {
  updatedAt?: string;
};

export const MEDICATION_ORDER_MAX_ENTRIES = 200;

/** Per-entry id length bound (cuids are 25 chars; leave headroom). */
export const MEDICATION_ORDER_ID_MAX_LENGTH = 64;

export const DEFAULT_MEDICATION_LIST_LAYOUT: MedicationListLayout = {
  version: 1,
  view: "cards",
  order: [],
};

function isMedicationListView(value: unknown): value is MedicationListView {
  return (
    typeof value === "string" &&
    (MEDICATION_LIST_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Tolerant read-side resolver: any malformed / legacy / partial blob
 * collapses onto the defaults field-by-field, so a GET can never fail on
 * a stored row and a new field added later defaults cleanly for blobs
 * persisted before it existed.
 */
export function resolveMedicationListLayout(
  raw: unknown,
): MedicationListLayout {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...DEFAULT_MEDICATION_LIST_LAYOUT, order: [] };
  }
  const blob = raw as { view?: unknown; order?: unknown };
  const view = isMedicationListView(blob.view)
    ? blob.view
    : DEFAULT_MEDICATION_LIST_LAYOUT.view;
  const order = Array.isArray(blob.order)
    ? dedupeOrder(
        blob.order.filter(
          (id): id is string =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= MEDICATION_ORDER_ID_MAX_LENGTH,
        ),
      )
    : [];
  return { version: 1, view, order };
}

/**
 * Write-side normaliser: dedupes the order list (first occurrence wins)
 * and caps it. The route merges absent fields from the stored blob
 * BEFORE calling this, so the result is always a complete layout.
 */
export function serializeMedicationListLayout(input: {
  view: MedicationListView;
  order: string[];
}): MedicationListLayout {
  return {
    version: 1,
    view: input.view,
    order: dedupeOrder(input.order).slice(0, MEDICATION_ORDER_MAX_ENTRIES),
  };
}

function dedupeOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
