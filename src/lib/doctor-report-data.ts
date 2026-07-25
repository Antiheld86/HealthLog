/**
 * The doctor-report aggregator's public surface.
 *
 * The work itself lives under `src/lib/doctor-report/` — the selection gate,
 * the dense-bucket query, the per-type series, the glucose panel, the
 * medication ledger, the structured clinical records and the orchestrator that
 * composes them. It was one 1,400-line function doing a dozen jobs; a gate
 * buried in the middle of that is a gate nobody re-reads.
 *
 * This module stays the single import path so no call site had to change.
 */
export * from "./doctor-report-types";
export * from "./doctor-report-helpers";
export { collectDoctorReportData } from "./doctor-report/collect";
