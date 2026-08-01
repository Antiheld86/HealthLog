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
  LIPIDS: "insights.healthScore.pillar.lipids",
};

/** Domain headings, one per distinct area of health. */
export const SCORE_DOMAIN_LABEL_KEYS: Record<ScoreDomain, string> = {
  cardiometabolic: "settings.sections.score.domain.cardiometabolic",
  activity: "settings.sections.score.domain.activity",
  sleep: "settings.sections.score.domain.sleep",
  adiposity: "settings.sections.score.domain.adiposity",
  wellbeing: "settings.sections.score.domain.wellbeing",
};
