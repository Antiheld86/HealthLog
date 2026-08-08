import type { MetricProvenanceMeta } from "./standards";

/**
 * The Health Score's own provenance entry, split out of the full
 * `METRIC_PROVENANCE` map.
 *
 * The eager insights overview reaches this value through
 * HeroStrip → HealthScoreCard, and it needs only this one metric's method key
 * and cited standard. Importing the whole map there dragged every derived
 * metric's citation (~30 entries of DOIs and key strings) into the overview's
 * initial bundle. Isolating the entry keeps the eager page down to the number
 * it renders; `METRIC_PROVENANCE.HEALTH_SCORE` re-exports this same value, so
 * the lazy score surfaces still read one source.
 *
 * Cited for the risk-factor set the pillars are drawn from, and for nothing
 * beyond it. HEARTS names the cardiometabolic factors worth following; it does
 * not prescribe an equal-weighted average of them, and since v1.35.0 it could
 * not, because which pillars enter that average is the account's own
 * selection. Naming the package plainly, as this entry used to, reads as a
 * standard endorsing whatever recipe the person happens to have chosen, which
 * is a claim nobody can make. The pillar-level citations in the map are
 * unaffected: each of those really does describe the band its pillar is graded
 * against.
 */
export const HEALTH_SCORE_PROVENANCE: MetricProvenanceMeta = {
  methodKey: "insights.healthScore.method",
  standard: {
    name: "WHO HEARTS technical package (risk-factor set)",
    url: "https://www.who.int/publications/i/item/9789240001367",
  },
};
