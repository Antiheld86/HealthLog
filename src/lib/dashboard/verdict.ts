/**
 * Dashboard hero — daily-verdict resolver.
 *
 * Pure function over an already-built `DashboardSnapshot`: no DB, no
 * network, no clock read (`now` is injected so the resolver is
 * deterministic under test and a cached snapshot can be re-evaluated
 * against the current instant).
 *
 * Nine rungs, first hit wins. The ordering is a severity ladder:
 * the fixed-floor BP emergency first (a fresh crisis-level reading
 * outranks an overdue dose), then the actionable medication states,
 * then trend nudges, then the briefing teaser, then the all-quiet
 * fallback. Threshold constants are imported from the client-safe
 * coach-nudge-thresholds leaf where one exists so the hero and the
 * nudge cron can never disagree on what "drift" or "deficit" means —
 * and so this module never pulls the cron's server graph into a
 * client bundle (this resolver runs inside `"use client"` code).
 *
 * Freshness is re-derived from the snapshot's ISO timestamps against
 * the injected `now` (not the snapshot's own `daysAgo` fields) so a
 * snapshot served from cache ages honestly.
 *
 * Defensive contract (cache staleness): a `medsToday.nextDueAt` in the
 * past with `nextDueOverdue: false` means the slot's anchor passed
 * after the snapshot was built. Rung 2 keys ONLY on the server-computed
 * `nextDueOverdue` flag and rung 3 requires `nextDueAt >= now`, so that
 * state falls through to the plain summary — never renders as overdue.
 */
import {
  COACH_NUDGE_WEIGHT_DRIFT_KG,
  COACH_NUDGE_SLEEP_DEFICIT_MARGIN_H,
} from "@/lib/jobs/coach-nudge-thresholds";
import { BP_SYS_CRITICAL, BP_DIA_CRITICAL } from "@/lib/clinical-floors";
import { userDayKey } from "@/lib/tz/format";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed clinical floors for the BP-critical rung — the canonical
 * hypertensive-crisis floors (sys ≥ 180 OR dia ≥ 120), imported from the
 * one source of truth `@/lib/clinical-floors` so the hero, the safety-floor
 * notification engine, and the Coach acute clause can never disagree on the
 * same reading (D3-H1). The diastolic floor is 120 (ACC/AHA), NOT the former
 * local 110: the wider 110 net lit the hero on readings the notification
 * engine left calm. Deliberately NOT the user's personal targets — a
 * user-relaxed threshold must never silence a crisis reading on the hero.
 */
const BP_CRITICAL_SYS_FLOOR = BP_SYS_CRITICAL;
const BP_CRITICAL_DIA_FLOOR = BP_DIA_CRITICAL;
/** A critical reading older than this many days is history, not an alert. */
const BP_CRITICAL_MAX_DAYS_AGO = 1;

/** Rung 3 — surface a dose at most this far before its anchor. */
const DOSE_UPCOMING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Rung 5 — nightly floor (hours) the short-nights rung measures against. */
const SHORT_NIGHTS_FLOOR_H = 7;
/** Rung 5 — minimum readings in the summary window before the rung fires. */
const SHORT_NIGHTS_MIN_COUNT = 5;

/** Rung 6 — every logged-ever core vital silent for at least this long. */
const SILENCE_MIN_DAYS = 7;
/** Rung 6 — the core vitals the silence rung watches. */
const SILENCE_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_GLUCOSE",
] as const;

/** Rung 7 — week-over-week score drop (points) that fires. */
const SCORE_DROP_MIN_POINTS = 10;

export type DashboardVerdictVariant =
  | "doseOverdue"
  | "bpCritical"
  | "doseUpcoming"
  | "weightDrift"
  | "shortNights"
  | "silence"
  | "scoreDrop"
  | "briefing"
  | "allQuiet";

export type DashboardVerdictCta =
  | { kind: "quickEntry"; target: "medicationIntake" | "measurement" }
  | { kind: "link"; href: string };

export interface DashboardVerdict {
  variant: DashboardVerdictVariant;
  /**
   * Interpolation values for the variant's i18n message. `briefing`
   * carries the model-authored headline VERBATIM under `headline`;
   * renderers must emit it as plain text children (no HTML, no
   * markdown) per the repo-wide no-markdown-renderer rule.
   */
  values: Record<string, string | number>;
  cta: DashboardVerdictCta | null;
}

/** HH:mm wall-clock of `d` in `tz`. */
function hmInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  // Some ICU builds emit "24:xx" for midnight under hour12: false.
  return parts.startsWith("24") ? `00${parts.slice(2)}` : parts;
}

/** Whole days between an ISO instant and `now` (floor; negative-safe). */
function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
}

export function resolveDashboardVerdict(
  snapshot: DashboardSnapshot,
  now: Date,
): DashboardVerdict {
  const meds = snapshot.medsToday;
  const tz = snapshot.user.timezone;
  const summaries = snapshot.tiles.summaries;
  const lastSeen = snapshot.tiles.lastSeenByType;

  // ── 1 · bpCritical ─────────────────────────────────────────────────
  // Fixed floors (sys ≥ 180 OR dia ≥ 120, from clinical-floors), never user
  // thresholds, and
  // only while the reading is fresh (≤ 1 day, re-derived against the
  // injected `now`). Sits ABOVE the overdue dose: a fresh crisis-level
  // reading is the one item that must not hide behind a routine
  // medication prompt.
  const sysLatest = summaries.BLOOD_PRESSURE_SYS?.latest ?? null;
  const diaLatest = summaries.BLOOD_PRESSURE_DIA?.latest ?? null;
  const sysSeen = lastSeen.BLOOD_PRESSURE_SYS;
  const bpCriticalValue =
    (sysLatest !== null && sysLatest >= BP_CRITICAL_SYS_FLOOR) ||
    (diaLatest !== null && diaLatest >= BP_CRITICAL_DIA_FLOOR);
  if (
    bpCriticalValue &&
    sysSeen &&
    daysSince(sysSeen.lastSeenAt, now) <= BP_CRITICAL_MAX_DAYS_AGO
  ) {
    return {
      variant: "bpCritical",
      values: { sys: sysLatest ?? 0, dia: diaLatest ?? 0 },
      cta: { kind: "link", href: "/insights/blood-pressure" },
    };
  }

  // ── 2 · doseOverdue ────────────────────────────────────────────────
  // Keys ONLY on the server-computed band-model flag. A stale cached
  // `nextDueAt` in the past with `nextDueOverdue: false` falls through
  // (defensive contract — see module doc).
  if (meds.nextDueOverdue === true) {
    return {
      variant: "doseOverdue",
      values: { name: meds.nextDueMedicationName ?? "" },
      cta: { kind: "quickEntry", target: "medicationIntake" },
    };
  }

  // ── 3 · doseUpcoming ───────────────────────────────────────────────
  // Unresolved doses remain today AND the next anchor sits within the
  // next two hours on the user's local calendar day.
  const unresolvedToday =
    meds.scheduledToday > meds.takenToday + meds.skippedToday;
  if (unresolvedToday && meds.nextDueAt !== null) {
    const dueMs = Date.parse(meds.nextDueAt);
    const untilDue = dueMs - now.getTime();
    if (
      untilDue >= 0 &&
      untilDue <= DOSE_UPCOMING_WINDOW_MS &&
      userDayKey(new Date(dueMs), tz) === userDayKey(now, tz)
    ) {
      return {
        variant: "doseUpcoming",
        values: {
          time: hmInTz(new Date(dueMs), tz),
          name: meds.nextDueMedicationName ?? "",
        },
        cta: { kind: "quickEntry", target: "medicationIntake" },
      };
    }
  }

  // ── 4 · weightDrift ────────────────────────────────────────────────
  // Distance-to-green-range drift: the 7-day mean sits further from the
  // green band than the 30-day mean by at least the coach-nudge drift
  // threshold.
  //
  // v1.34 — the band comes off the snapshot's resolved `targetBands`, which
  // honours the user's own weight target when they set one. The rung used to
  // recompute the height-derived BMI band inline, so it nudged about drifting
  // away from a band the user had explicitly replaced. No band on the snapshot
  // (no height and no target) → skip.
  const weight = summaries.WEIGHT;
  const weightRange = snapshot.targetBands.weightRange;
  if (weightRange && weight && weight.avg7 !== null && weight.avg30 !== null) {
    const dist = (x: number): number =>
      Math.max(0, weightRange.greenMin - x, x - weightRange.greenMax);
    if (dist(weight.avg7) - dist(weight.avg30) >= COACH_NUDGE_WEIGHT_DRIFT_KG) {
      return {
        variant: "weightDrift",
        values: {},
        cta: { kind: "link", href: "/insights/weight" },
      };
    }
  }

  // ── 5 · shortNights ────────────────────────────────────────────────
  // 7-day mean sleep (stored in minutes) clearly under the floor, with
  // enough readings that a sparse week stays silent. The clear-margin
  // is the same constant the coach-nudge sleep trigger uses.
  const sleep = summaries.SLEEP_DURATION;
  if (sleep && sleep.avg7 !== null && sleep.count >= SHORT_NIGHTS_MIN_COUNT) {
    const floorMinutes =
      (SHORT_NIGHTS_FLOOR_H - COACH_NUDGE_SLEEP_DEFICIT_MARGIN_H) * 60;
    if (sleep.avg7 < floorMinutes) {
      return {
        variant: "shortNights",
        values: { hours: Math.round((sleep.avg7 / 60) * 10) / 10 },
        cta: { kind: "link", href: "/insights/sleep" },
      };
    }
  }

  // ── 6 · silence ────────────────────────────────────────────────────
  // EVERY logged-ever core vital has been silent for ≥ 7 days (min over
  // the per-type ages). Types the user never logged don't count — a
  // BP-only account is judged on BP alone.
  let minDaysAgo: number | null = null;
  for (const type of SILENCE_TYPES) {
    const seen = lastSeen[type];
    if (!seen) continue;
    const days = daysSince(seen.lastSeenAt, now);
    if (minDaysAgo === null || days < minDaysAgo) minDaysAgo = days;
  }
  if (minDaysAgo !== null && minDaysAgo >= SILENCE_MIN_DAYS) {
    return {
      variant: "silence",
      values: { days: minDaysAgo },
      cta: { kind: "quickEntry", target: "measurement" },
    };
  }

  // ── 7 · scoreDrop ──────────────────────────────────────────────────
  const score = snapshot.healthScore;
  if (
    score !== null &&
    score.delta !== null &&
    score.deltaReason === null &&
    score.delta <= -SCORE_DROP_MIN_POINTS
  ) {
    return {
      variant: "scoreDrop",
      values: { points: Math.round(Math.abs(score.delta)) },
      cta: { kind: "link", href: "/insights" },
    };
  }

  // ── 8 · briefing ───────────────────────────────────────────────────
  // Fresh briefing only (`ready` + not stale) with at least one key
  // finding. Prefer a "watch"-tone finding; the headline rides verbatim
  // as plain text — see the `values` doc.
  if (
    snapshot.briefingState === "ready" &&
    !snapshot.briefingStale &&
    snapshot.briefing !== null &&
    snapshot.briefing.keyFindings.length > 0
  ) {
    const findings = snapshot.briefing.keyFindings;
    const picked = findings.find((f) => f.tone === "watch") ?? findings[0];
    return {
      variant: "briefing",
      // `sourceMetric` rides along so the hero can deep-link the
      // sentence to the picked finding's metric sub-page (METRIC_HREF);
      // renderers that don't know the field ignore it.
      values: { headline: picked.headline, sourceMetric: picked.sourceMetric },
      cta: { kind: "link", href: "/insights" },
    };
  }

  // ── 9 · allQuiet ───────────────────────────────────────────────────
  return { variant: "allQuiet", values: {}, cta: null };
}
