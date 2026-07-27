/**
 * v1.4.25 W19b — container inventory state machine.
 *
 * Pure functions over a minimal `InventoryItemView` shape — no DB
 * access, no Prisma imports. The route handlers, the consumption hook
 * (`./consumption.ts`), and the daily expire cron all compose this
 * module with their own persistence layer.
 *
 * Decision tree (in evaluation order):
 *   1. unitsRemaining === 0           → USED_UP   (terminal)
 *   2. printedExpiry  && now > expiry → EXPIRED   (printed label trumps clock)
 *   3. firstUseAt && the container carries a post-opening clock &&
 *      now > firstUseAt + IN_USE_WINDOW_MS               → EXPIRED
 *   4. firstUseAt is set              → IN_USE
 *   5. otherwise                      → ACTIVE
 *
 * v1.16.10 — the item counts UNITS (tablets / ampoules / puffs), not
 * doses; `Medication.unitsPerDose` maps between the two. The state
 * machine is unit-agnostic — it only cares whether the count reached
 * zero.
 *
 * ## Which containers carry a post-opening clock
 *
 * Clause 3 exists because breaching a sealed multi-dose reservoir
 * exposes its contents: an injection pen's septum is punctured on the
 * first dose and the product information caps how long the remainder
 * stays usable (EMA EPAR §6.3). That fact is a property of the
 * CONTAINER, not of every supply row, and applying it blindly wrote off
 * good stock: pressing the first tablet out of a blister started a
 * 30-day clock and a month later the untouched remainder was EXPIRED.
 *
 * So the clock now keys off `containerType`
 * ({@link IN_USE_CLOCK_CONTAINER_TYPES}):
 *
 *   - PEN — one sealed multi-dose reservoir, punctured on first use.
 *     The clock is the reason clause 3 exists.
 *   - AMPOULE — the member a punctured injectable reservoir (ampoule or
 *     multi-dose vial) lands on; there is no separate VIAL member. Same
 *     physical fact as the pen: the barrier is broken and the contents
 *     are exposed. The enum cannot tell that reservoir apart from a
 *     carton of single-use glass ampoules, where the clock would be
 *     wrong for the same reason it was wrong on a blister; the kind is
 *     never auto-selected, so choosing it is a deliberate statement
 *     about a container that was opened, and the opening date is
 *     editable when it turns out not to be.
 *   - BLISTER — every tablet sits in its own sealed foil cavity.
 *     Pressing out tablet 1 does nothing to tablets 2..n. The carton
 *     expiry is the only expiry.
 *   - INHALER — a pressurised canister has no in-use limit at all, and
 *     the dry-powder devices that do state months, not 30 days. Any
 *     fixed default here would be a fabricated number.
 *   - BOTTLE — a bottle of tablets has no in-use limit. A bottle of
 *     suspension or drops does, but it is product-specific and the enum
 *     cannot tell the two apart.
 *   - OTHER — the backfill default for every row that never chose a
 *     kind. Nothing about it says a limit exists, so none is invented.
 *
 * For every clock-less kind the printed expiry (clause 2) still applies
 * in full — an unknown container is not an unbounded one. What it does
 * not get is a deadline nobody entered, because writing stock off on a
 * guess hides supply the user physically holds and mutes the low-stock
 * signal that would have told them to reorder.
 *
 * ## Window length
 *
 * The window is fixed at 30 days per EMA EPAR §6.3 for Mounjaro
 * KwikPen / Saxenda. The per-product window is NOT read from the
 * drug-knowledge layer (`glp1-knowledge.ts`) even though it carries one
 * (`inUse.maxDays`: 14 for Trulicity, 56 for Ozempic): the only bridge
 * from an inventory row to a `Glp1DrugId` is a fuzzy match on the
 * free-text `Medication.name` (`findDrugIdByBrand`), and a mismatch
 * there would shorten a window and write stock off — the exact failure
 * this module just removed. The state machine stays window-agnostic:
 * it accepts the window length as input, so a caller that can name the
 * product with certainty can pass its own.
 */

import type {
  MedicationContainerType,
  MedicationInventoryState,
} from "@/generated/prisma/client";
import {
  IN_USE_CLOCK_CONTAINER_TYPES as CLOCK_CONTAINER_TYPES,
  startsInUseClock,
} from "./clock-container-types";

/** Default in-use window per EMA EPAR §6.3 for the strictest GLP-1
 *  agonists (Mounjaro, Saxenda). 30 days. */
export const DEFAULT_IN_USE_WINDOW_DAYS = 30;

/**
 * Container kinds whose first opening starts a degradation clock — the
 * ones that are a single sealed reservoir breached by the first dose.
 * Every other kind holds individually sealed units (or an unknown
 * arrangement) and expires only on its printed date. See the module
 * docblock for the per-member reasoning.
 *
 * The list itself lives in `./clock-container-types`, which the settings
 * client can import; `satisfies` here is the drift guard, so a container
 * kind renamed or dropped from the column stops compiling instead of
 * quietly never matching.
 */
export const IN_USE_CLOCK_CONTAINER_TYPES =
  CLOCK_CONTAINER_TYPES satisfies readonly MedicationContainerType[];

/** Does opening this container start the in-use window? */
export function hasInUseClock(containerType: MedicationContainerType): boolean {
  return startsInUseClock(containerType);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The subset of `MedicationInventoryItem` the state machine needs.
 * Decoupling here means tests don't have to construct a full Prisma
 * row, and the helper composes cleanly with the route layer's
 * partial-update shapes.
 */
export interface InventoryItemView {
  state: MedicationInventoryState;
  containerType: MedicationContainerType;
  unitsTotal: number;
  unitsRemaining: number;
  firstUseAt: Date | null;
  printedExpiry: Date | null;
}

/**
 * Resolve the canonical state for a container given the wall clock.
 *
 * The function is pure — given the same input it always returns the
 * same state — so the caller can re-evaluate as often as it wants
 * without side-effects. The expire-cron and the consumption hook both
 * use this same evaluator; the only difference is what they do with
 * the result.
 */
export function computeInventoryState(
  item: InventoryItemView,
  nowMs: number,
  inUseWindowDays: number = DEFAULT_IN_USE_WINDOW_DAYS,
): MedicationInventoryState {
  // (1) Terminal — once a container is used up, it stays used up. The
  // printed expiry on an empty container is irrelevant; the EXPIRED
  // state exists to warn the user not to dose from a container that's
  // still got units but has gone stale, and an empty one has neither
  // problem.
  if (item.unitsRemaining <= 0) {
    return "USED_UP";
  }

  // (2) Printed expiry trumps the in-use clock. A container whose
  // carton expiry has lapsed is EXPIRED even if it was never opened.
  // This clause applies to EVERY container kind.
  if (item.printedExpiry && nowMs > item.printedExpiry.getTime()) {
    return "EXPIRED";
  }

  // (3) In-use clock blew — only for the kinds that have one.
  // firstUseAt + window < now ⇒ EXPIRED.
  if (item.firstUseAt) {
    if (hasInUseClock(item.containerType)) {
      const inUseDeadlineMs =
        item.firstUseAt.getTime() + inUseWindowDays * MS_PER_DAY;
      if (nowMs > inUseDeadlineMs) {
        return "EXPIRED";
      }
    }
    // (4) Has been opened. A clock-less container stays IN_USE for as
    // long as it holds units — "opened" is a true statement about it,
    // it just carries no deadline of its own.
    return "IN_USE";
  }

  // (5) Sealed, unopened.
  return "ACTIVE";
}

/**
 * Compute the `expiresAt` column — the instant the daily expire-cron
 * scans for.
 *
 * For a container with a post-opening clock it is the min of the in-use
 * deadline (firstUseAt + window) and the printed expiry, whichever
 * lands first. For every other kind the printed expiry is the only
 * deadline there is, so an opened blister with no printed date carries
 * no `expiresAt` at all and the cron never sees it. If neither applies
 * we return null.
 */
export function computeExpiresAt(
  firstUseAt: Date | null,
  printedExpiry: Date | null,
  containerType: MedicationContainerType,
  inUseWindowDays: number = DEFAULT_IN_USE_WINDOW_DAYS,
): Date | null {
  const inUseDeadline =
    firstUseAt && hasInUseClock(containerType)
      ? new Date(firstUseAt.getTime() + inUseWindowDays * MS_PER_DAY)
      : null;

  if (inUseDeadline && printedExpiry) {
    return inUseDeadline.getTime() < printedExpiry.getTime()
      ? inUseDeadline
      : printedExpiry;
  }
  return inUseDeadline ?? printedExpiry ?? null;
}
