/**
 * Deterministic identity keys for the dismissible (observational) Today rail
 * items — `milestone`, `ecg_new_recording`, `tension_window`. Pure string
 * formatting, no DB, no clock: both the digest composer (`./digest.ts`, which
 * stamps the key onto the emitted `PriorityItem`) and the IO seam
 * (`./load-digest.ts`, which needs the SAME keys to look up which of today's
 * candidates are already dismissed) import from here so the format is one
 * source of truth.
 *
 * Each key is namespaced `<kind>:...` (see `isDismissibleItemKey` in
 * `./priority-item.ts`) and folds in enough of the underlying candidate's own
 * identity that a fresh instance the NEXT day never collides with today's
 * dismissed one — a milestone by its reach day, an ECG recording by its own
 * timestamp, a tension window by the local day it was detected for.
 */
import type { Milestone } from "@/lib/daily/milestones";

/** `milestone:<kind>:<metricType>:<sinceDate>` — one key per durable state reached. */
export function milestoneItemKey(
  milestone: Pick<Milestone, "kind" | "metricType" | "sinceDate">,
): string {
  return `milestone:${milestone.kind}:${milestone.metricType}:${milestone.sinceDate}`;
}

/** `ecg_new_recording:<recordedAt ISO>` — the recording's own timestamp is unique. */
export function ecgItemKey(recordedAt: Date): string {
  return `ecg_new_recording:${recordedAt.toISOString()}`;
}

/**
 * `tension_window:<localDayKey>:<partOfDay>` — at most one per user per day.
 * `partOfDay` mirrors `DailyDigestTensionWindow["partOfDay"]` (`./digest.ts`)
 * by value rather than by import, so this module stays a leaf the digest
 * composer can depend on without a cycle.
 */
export function tensionWindowItemKey(
  localDayKey: string,
  partOfDay: "morning" | "afternoon" | "evening" | "night",
): string {
  return `tension_window:${localDayKey}:${partOfDay}`;
}

/**
 * `same_time_baseline:<localDayKey>:<MeasurementType>` — one key per metric
 * per local day.
 *
 * Deliberately NOT keyed on the hour the comparison was anchored to. The card
 * refreshes as the day goes on, and folding the hour into the key would mean a
 * dismissal at 14:00 was undone at 15:00 — the user would have to swat the
 * same card away nine times before bed. Dismissing it means "not today".
 */
export function sameTimeBaselineItemKey(
  localDayKey: string,
  type: string,
): string {
  return `same_time_baseline:${localDayKey}:${type}`;
}

/** One persisted acknowledgement per Health Score algorithm version. */
export function healthScoreAlgorithmItemKey(scoreVersion: number): string {
  return `health_score_algorithm:${scoreVersion}`;
}
