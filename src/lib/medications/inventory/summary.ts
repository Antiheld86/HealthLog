/**
 * v1.16.10 — shared supply-summary math for every stock readout.
 *
 * One predicate decides what counts as AVAILABLE supply: ACTIVE or
 * IN_USE containers with units left — the same filter the medications
 * list route (`stockUnitsRemaining`), the GLP-1 detail endpoint and the
 * Coach snapshot run. EXPIRED stock is visible but never available:
 * it surfaces separately (`expiredUnits`) so the UI can show a muted
 * "expired" suffix without folding it into the headline or the runway
 * estimate. USED_UP containers count nowhere.
 *
 * The Übersicht supply row and the Bestand summary both render from
 * this helper, so the surfaces cannot disagree about what "remaining"
 * means.
 *
 * v1.18.11 (#31) — this is also the single canonical sanity gate for
 * the surfaced stock. A self-hoster reported the headline Bestand going
 * nonsensically NEGATIVE. The container write paths floor at zero
 * structurally (consumption never over-decrements, the stock-correction
 * route clamps at `.min(0)` and re-runs the state machine), and the
 * legacy running-sum ledger reads are clamped with `Math.max(0, …)` at
 * their two call sites — but nothing guaranteed the POOLED figure this
 * helper returns could not go negative from a single corrupt / legacy
 * row carrying a negative `unitsRemaining` (or `unitsTotal`). Rather
 * than leave each surface to re-clamp, the floor lives HERE, at the one
 * point every readout flows through. The matching `medication.inventory.underflow`
 * wide-event is emitted by the server-side caller (`evaluateMedicationRunway`
 * in the low-stock job) via the pure `detectSupplyUnderflow` predicate below —
 * this module imports no request-scoped logging so it stays safe to bundle into
 * the client detail surfaces that also render from it.
 */

import { floorWhole } from "@/lib/medications/units-per-dose";

export type SupplyItemState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

export interface SupplyItem {
  state: SupplyItemState;
  unitsTotal: number;
  unitsRemaining: number;
}

export interface SupplySummary {
  /** Pooled units across available (ACTIVE / IN_USE, units left) containers. */
  unitsRemaining: number;
  /** Pooled capacity across the same available containers. */
  unitsTotal: number;
  /** Dose-derived headline: floor(unitsRemaining / unitsPerDose). */
  dosesRemaining: number;
  /** Dose-derived capacity: floor(unitsTotal / unitsPerDose). */
  dosesTotal: number;
  /** Units still sitting in EXPIRED containers — visible, never available. */
  expiredUnits: number;
}

/** Raw figures behind a clamped pool, captured when the available pool would
 *  otherwise have surfaced a non-finite or negative Bestand. */
export interface SupplyUnderflow {
  rawUnitsRemaining: number | null;
  rawUnitsTotal: number | null;
  clampedUnitsRemaining: number;
  availableCount: number;
}

/** The list-route / GLP-1 availability predicate, verbatim. */
export function isAvailableSupply(item: SupplyItem): boolean {
  return (
    (item.state === "ACTIVE" || item.state === "IN_USE") &&
    item.unitsRemaining > 0
  );
}

export function summariseSupply(
  items: readonly SupplyItem[],
  unitsPerDose: number,
): SupplySummary {
  // v1.16.12 — guard at > 0, NOT ≥ 1: a fractional unitsPerDose (½ tablet
  // per dose) must stay fractional, else the dose-derived counts halve.
  const perDose = unitsPerDose > 0 ? unitsPerDose : 1;
  const available = items.filter(isAvailableSupply);
  const rawUnitsRemaining = available.reduce(
    (sum, item) => sum + item.unitsRemaining,
    0,
  );
  const rawUnitsTotal = available.reduce(
    (sum, item) => sum + item.unitsTotal,
    0,
  );
  const expiredUnits = clampNonNegative(
    items
      .filter((item) => item.state === "EXPIRED")
      .reduce((sum, item) => sum + item.unitsRemaining, 0),
  );

  // v1.18.11 (#31) — central sanity gate. A NaN / negative pool can only
  // come from a corrupt or legacy row that slipped past the per-row
  // availability predicate; never surface it. Clamp to zero (the dose
  // ran out). The matching underflow wide-event is emitted by the
  // server-side caller through `detectSupplyUnderflow` — this helper stays
  // pure so it can bundle into the client detail surfaces.
  const unitsRemaining = clampNonNegative(rawUnitsRemaining);
  const unitsTotal = clampNonNegative(rawUnitsTotal);

  return {
    unitsRemaining,
    unitsTotal,
    dosesRemaining: floorWhole(unitsRemaining / perDose),
    dosesTotal: floorWhole(unitsTotal / perDose),
    expiredUnits,
  };
}

/**
 * Pure underflow detector for the available pool. Returns the raw figures
 * (and the clamped result) when the available containers would have summed
 * to a non-finite or negative Bestand, else `null`. No request-scoped logging
 * import, so it is safe to bundle anywhere; a server caller with a request
 * context turns a non-null result into the `medication.inventory.underflow`
 * wide-event.
 */
export function detectSupplyUnderflow(
  items: readonly SupplyItem[],
): SupplyUnderflow | null {
  const available = items.filter(isAvailableSupply);
  const rawUnitsRemaining = available.reduce(
    (sum, item) => sum + item.unitsRemaining,
    0,
  );
  const rawUnitsTotal = available.reduce(
    (sum, item) => sum + item.unitsTotal,
    0,
  );
  const underflowed =
    !Number.isFinite(rawUnitsRemaining) ||
    rawUnitsRemaining < 0 ||
    !Number.isFinite(rawUnitsTotal) ||
    rawUnitsTotal < 0;
  if (!underflowed) return null;
  return {
    rawUnitsRemaining: Number.isFinite(rawUnitsRemaining)
      ? rawUnitsRemaining
      : null,
    rawUnitsTotal: Number.isFinite(rawUnitsTotal) ? rawUnitsTotal : null,
    clampedUnitsRemaining: clampNonNegative(rawUnitsRemaining),
    availableCount: available.length,
  };
}

/** Floor a pooled figure at zero, treating a non-finite value as zero
 *  too — a corrupt row must never surface as `NaN` or a negative. */
function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
