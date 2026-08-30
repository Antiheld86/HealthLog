/**
 * v1.38 — the breadth rule, in one place, and no longer a floor.
 *
 * Until now a composite Health Score existed only when the pillars behind
 * it spanned at least three distinct domains and included at least one
 * physiological measure. Everything below that line got "not enough data
 * yet" — including accounts that had a perfectly readable standing in one
 * or two areas. The refusal told those people nothing they could not
 * already see, and it hid a number they had earned.
 *
 * So three domains stops being the price of admission and becomes the
 * recommendation it always described: the score is computed the same way
 * at every breadth, and the verdict says how broad it is. `full` is the
 * old rule, `partial` is two domains, `minimal` is one. Refusal survives
 * for the one case where there is genuinely nothing to average — no ok
 * pillar at all.
 *
 * The physiological question moves with it. It is now a labelling fact
 * rather than a veto: an account whose only ok pillar is activity or
 * wellbeing gets a `minimal` score that says on its face what it rests
 * on, which is more than the old refusal ever said. The arithmetic does
 * not change with the tier — inventing a discount for the pillars
 * somebody does not track would be exactly the made-up target this score
 * spent two releases removing.
 *
 * Both layers still call this function. The settings write refuses an
 * empty selection, the scorer refuses an empty ok set, and neither
 * restates the rule.
 */
import {
  SCORE_PILLAR_DOMAINS,
  type ScoreDomain,
  type ScorePillarId,
} from "./types";

/**
 * The breadth the score recommends, not the breadth it requires.
 *
 * Still the denominator `deriveCoverage` counts distinct domains
 * against, which is what makes a partial score read as partial without
 * any new machinery: one domain of three lands at low confidence through
 * the blend that was already there.
 */
export const SCORE_RECOMMENDED_DOMAINS = 3;

/**
 * Pillars that rest on a physiological measurement. `ACTIVITY` and
 * `WELLBEING` are the only two that do not. This no longer decides
 * whether a score exists; it decides what the score says about itself.
 */
const PHYSIOLOGICAL_PILLARS: ReadonlySet<ScorePillarId> = new Set([
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "SLEEP",
  "ADIPOSITY",
  "LIPIDS",
]);

/**
 * How broad the set behind a score is. Ordered by breadth, and named
 * rather than numbered so a surface can speak about it without
 * re-deriving the thresholds.
 */
export type ScoreBreadthTier = "full" | "partial" | "minimal";

/**
 * The one thing that still refuses. A set with no ok pillar has nothing
 * to average, and a mean over nothing is not a low score, it is an
 * absent one.
 */
export type ScoreBreadthFailure = "no_pillars_selected";

/**
 * Discriminated on `ok` so a caller that has checked cannot then read a
 * reason that is not there, and cannot skip the check to get a tier.
 * `domains` carries the distinct domains the set spans; `physiological`
 * carries whether any of them rests on a measurement, for the label.
 */
export type ScoreBreadthVerdict =
  | {
      ok: true;
      reason: null;
      tier: ScoreBreadthTier;
      domains: ScoreDomain[];
      physiological: boolean;
    }
  | {
      ok: false;
      reason: ScoreBreadthFailure;
      tier: null;
      domains: ScoreDomain[];
      physiological: boolean;
    };

/**
 * Judge a pillar set against the breadth rule.
 *
 * The tier is a function of DOMAINS, not pillars, which is why blood
 * pressure, glucose and cholesterol together are `minimal`: three
 * pillars, one area of health.
 */
export function evaluateScoreBreadth(
  ids: readonly ScorePillarId[],
): ScoreBreadthVerdict {
  const domains = [...new Set(ids.map((id) => SCORE_PILLAR_DOMAINS[id]))];
  const physiological = ids.some((id) => PHYSIOLOGICAL_PILLARS.has(id));
  if (domains.length === 0) {
    return {
      ok: false,
      reason: "no_pillars_selected",
      tier: null,
      domains,
      physiological,
    };
  }
  const tier: ScoreBreadthTier =
    domains.length >= SCORE_RECOMMENDED_DOMAINS
      ? "full"
      : domains.length === 2
        ? "partial"
        : "minimal";
  return { ok: true, reason: null, tier, domains, physiological };
}
