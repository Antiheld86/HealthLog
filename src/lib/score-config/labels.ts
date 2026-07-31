/**
 * The localised names of the score's pillars and the domains they sit in.
 *
 * One map per concept, read by the hero panel and by the settings surface
 * that decides what counts. Two copies of a name map drift the moment one
 * surface renames a pillar, and the two surfaces would then be talking
 * about different things while showing the same list.
 */
import type { ScoreDomain, ScorePillarId } from "@/lib/analytics/score/types";

export const SCORE_PILLAR_LABEL_KEYS: Record<ScorePillarId, string> = {
  BLOOD_PRESSURE: "insights.healthScore.pillar.bloodPressure",
  GLYCAEMIA: "insights.healthScore.pillar.glycaemia",
  ACTIVITY: "insights.healthScore.pillar.activity",
  SLEEP: "insights.healthScore.pillar.sleep",
  ADIPOSITY: "insights.healthScore.pillar.adiposity",
  WELLBEING: "insights.healthScore.pillar.wellbeing",
  FITNESS: "insights.healthScore.pillar.fitness",
  LIPIDS: "insights.healthScore.pillar.lipids",
};

/**
 * Domain headings. The cardiometabolic one carries three pillars, which
 * is the whole reason the surface groups at all: equal weight per pillar
 * is not equal weight per area, and nothing in the app said so before.
 */
export const SCORE_DOMAIN_LABEL_KEYS: Record<ScoreDomain, string> = {
  cardiometabolic: "settings.sections.score.domain.cardiometabolic",
  activity: "settings.sections.score.domain.activity",
  sleep: "settings.sections.score.domain.sleep",
  adiposity: "settings.sections.score.domain.adiposity",
  wellbeing: "settings.sections.score.domain.wellbeing",
  fitness: "settings.sections.score.domain.fitness",
};

/**
 * Domains that need a sentence under the heading. Only the one that
 * carries more than one pillar does, and it is not decoration: without it
 * the triple count stays invisible and deselecting one of the three
 * reshapes the balance with no cue.
 */
export const SCORE_DOMAIN_NOTE_KEYS: Partial<Record<ScoreDomain, string>> = {
  cardiometabolic: "settings.sections.score.domainNote.cardiometabolic",
};
