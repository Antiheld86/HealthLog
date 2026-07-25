/**
 * The one place a doctor-report leaf is admitted or refused.
 *
 * Two independent gates, and both must pass:
 *
 *   - the per-artefact SELECTION the owner made for this report, and
 *   - the app-wide MODULE switch that decides whether the domain exists here
 *     at all.
 *
 * A disabled module wins over a selected leaf; a deselected leaf wins over an
 * enabled module. Neither softens the other.
 *
 * The gate is fail-closed in both directions. A leaf the selection does not
 * carry is excluded, because membership is inclusion and there is no default
 * to consult. A measurement type the catalogue does not know is also excluded
 * — and annotated, so a drifted enum shows up in the wide-event stream instead
 * of riding out on a clinical document. The old filter passed such a type
 * through, which is what made "we forgot to map it" the same as "the user
 * asked for it".
 */
import type { ModuleKey } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import {
  LEAF_MODULE,
  isReportLeafId,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import type { ReportSelection } from "@/lib/report-selection/selection";
import type { MeasurementType } from "@/generated/prisma/client";

/** A resolved gate: one question, asked the same way everywhere. */
export interface ReportGate {
  /** Whether this artefact carries the leaf. */
  admits(leaf: ReportLeafId): boolean;
  /** The leaves that survived both gates, in catalogue order. */
  readonly admitted: readonly ReportLeafId[];
}

export function resolveReportGate(
  selection: ReportSelection,
  moduleMap: Record<ModuleKey, boolean>,
): ReportGate {
  const admits = (leaf: ReportLeafId): boolean => {
    if (!selection.has(leaf)) return false;
    const moduleKey = LEAF_MODULE[leaf];
    if (moduleKey && moduleMap[moduleKey] === false) return false;
    return true;
  };
  return { admits, admitted: selection.leaves.filter(admits) };
}

/**
 * The measurement types to exclude at QUERY time.
 *
 * Rows of a refused leaf are not fetched only to be dropped — the heaviest
 * series (minute-grain CGM, per-sample heart rate) is exactly the one that
 * runs to six figures over a long window, and a leaf the owner withheld should
 * not enter this process's memory at all.
 *
 * `keepForDerived` names the types the aggregator reads BEFORE the output
 * filter and therefore must not exclude even when the leaf itself is refused:
 * the BMI figure and the GLP-1 weight delta are both computed from weight rows
 * and are gated by their own leaves.
 */
export function excludedMeasurementTypes(
  gate: ReportGate,
  allTypes: readonly MeasurementType[],
  keepForDerived: ReadonlySet<MeasurementType>,
): MeasurementType[] {
  return allTypes.filter(
    (type) => !gate.admits(type) && !keepForDerived.has(type),
  );
}

/**
 * Strip every measurement type the gate refuses from a type-keyed map.
 *
 * This is the output half of the same decision the query gate makes, reading
 * the same gate object, so the two can never disagree. A type that is not a
 * catalogue leaf at all is excluded and annotated rather than passed through.
 */
export function filterMeasurementKeys<T>(
  map: Record<string, T>,
  gate: ReportGate,
): Record<string, T> {
  const out: Record<string, T> = {};
  const unmapped = new Set<string>();
  for (const [type, value] of Object.entries(map)) {
    if (!isReportLeafId(type)) {
      // Meta, not `action` — the wide event carries one action name and it
      // belongs to the route that is serving the request. The key is stable so
      // a dashboard can alert on it.
      unmapped.add(type);
      continue;
    }
    if (!gate.admits(type)) continue;
    out[type] = value;
  }
  if (unmapped.size > 0) {
    annotate({ meta: { reportUnmappedLeaves: [...unmapped].sort() } });
  }
  return out;
}
