/**
 * Cycle prediction + phase engine — public surface.
 *
 * Pure, deterministic, DB-free. The iOS team re-implements this 1:1 in Swift
 * from `.planning/v1.15-cycle/algorithm.md`; the unit-test fixtures under
 * `__tests__/` are the shared parity contract.
 */

export * from "./types";
export * from "./day-math";
export {
  predictCycle,
  estimateCycleLength,
  estimatePeriodLength,
  observedPeriodLength,
  detectTempShift,
  detectMucusPeak,
  confirmSymptothermal,
  detectTemperatureTrend,
  detectLhSurgeOvulation,
  median,
  mad,
  resolveLuteal,
  clampLuteal,
} from "./prediction";
export { phaseForDay, phaseSeries, type PhaseCycle } from "./phase";
export {
  resolveCycleVerdict,
  type CycleVerdict,
  type CycleVerdictState,
  type CyclePhaseSpan,
  type CycleProfileLengths,
  type VerdictCalendarDay,
} from "./verdict";
