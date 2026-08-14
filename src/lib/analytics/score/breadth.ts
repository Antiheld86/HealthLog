/**
 * v1.35.0 — the breadth rule, in one place.
 *
 * A composite Health Score exists only when the pillars behind it span
 * at least three distinct domains and include at least one physiological
 * measure. Before per-user composition the rule lived inside
 * `computeComposite` alone, because nothing else could narrow the set.
 * Now two layers apply it: the settings write refuses a selection that
 * cannot produce a score, and the scorer refuses to produce one anyway.
 * That is deliberate defence in depth, and it is only honest if both
 * layers ask the same question, so both call this function.
 */
import {
  SCORE_PILLAR_DOMAINS,
  type ScoreDomain,
  type ScorePillarId,
} from "./types";

export const SCORE_MIN_ELIGIBLE_DOMAINS = 3;

/**
 * Pillars that rest on a physiological measurement. `ACTIVITY` and
 * `WELLBEING` are the only two that do not, which is why a selection of
 * those two alone yields no score however many domains it spans.
 */
const PHYSIOLOGICAL_PILLARS: ReadonlySet<ScorePillarId> = new Set([
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "SLEEP",
  "ADIPOSITY",
  "LIPIDS",
]);

export type ScoreBreadthFailure =
  "three_domains_required" | "measured_physiological_domain_required";

/**
 * Discriminated on `ok` so a caller that has checked cannot then read a
 * reason that is not there, and cannot skip the check to get one.
 * `domains` carries the distinct domains the set spans, for a caller
 * that has to explain the refusal.
 */
export type ScoreBreadthVerdict =
  | { ok: true; reason: null; domains: ScoreDomain[] }
  | { ok: false; reason: ScoreBreadthFailure; domains: ScoreDomain[] };

/**
 * Judge a pillar set against the breadth rule.
 *
 * The missing-physiological reason wins when both fail, because it is
 * the more specific thing to tell someone: adding a third domain that
 * is neither blood pressure nor a lab still leaves them without a score.
 */
export function evaluateScoreBreadth(
  ids: readonly ScorePillarId[],
): ScoreBreadthVerdict {
  const domains = [...new Set(ids.map((id) => SCORE_PILLAR_DOMAINS[id]))];
  const hasPhysiological = ids.some((id) => PHYSIOLOGICAL_PILLARS.has(id));
  if (!hasPhysiological) {
    return {
      ok: false,
      reason: "measured_physiological_domain_required",
      domains,
    };
  }
  if (domains.length < SCORE_MIN_ELIGIBLE_DOMAINS) {
    return { ok: false, reason: "three_domains_required", domains };
  }
  return { ok: true, reason: null, domains };
}
