/**
 * A stored feature key, in the reader's own language.
 *
 * The keys in `MoodPrediction.features` are stable identifiers, not copy. This
 * turns one into a label, and it does so out of the strings the capture
 * surfaces already use: a person reads "Workload" here because that is what
 * the slider they moved was called, not because a second wording was invented
 * for the explanation.
 *
 * Every key it cannot place returns `null`, and that path is real rather than
 * defensive: a row written by an older `modelVersion` can name a feature this
 * build has dropped, and skipping it is better than rendering an identifier at
 * somebody.
 */
import { parseFeatureKey } from "@/lib/analytics/mood-prognosis/feature-keys";
import { contextValueLabelKey } from "@/lib/mood/context-vocabulary";
import { getMoodDimension } from "@/lib/mood/dimensions";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * The five linked figures, resolved through literal keys.
 *
 * A switch rather than a computed key so the call-site coverage guard can see
 * every string this file can ask for. The keys are the capture sheet's own
 * (`mood.dayContext.linked*`), which is the point: the label a figure carries
 * in the explanation is the label it carries where it was read.
 */
function linkedLabel(metric: string, t: Translate): string | null {
  switch (metric) {
    case "sleepAsleep":
      return t("mood.dayContext.linkedSleep");
    case "steps":
      return t("mood.dayContext.linkedSteps");
    case "activeEnergy":
      return t("mood.dayContext.linkedActiveEnergy");
    case "restingHeartRate":
      return t("mood.dayContext.linkedRestingHeartRate");
    case "heartRateVariability":
      return t("mood.dayContext.linkedHrv");
    default:
      return null;
  }
}

export function prognosisFeatureLabel(
  key: string,
  t: Translate,
): string | null {
  const parsed = parseFeatureKey(key);
  if (parsed === null) return null;

  if (parsed.family === "dimension") {
    const dimension = getMoodDimension(parsed.dimension);
    return dimension ? t(dimension.labelKey) : null;
  }
  if (parsed.family === "linked") return linkedLabel(parsed.metric, t);

  const field = t(`mood.context.field.${parsed.field}`);
  if (parsed.value === null) return field;
  // "Working day: longer than usual" — the field and the value the person
  // picked, joined by a pattern rather than by a hard-coded colon, because the
  // punctuation between them is a locale's business.
  return t("insights.mood.prognosis.featureValue", {
    field,
    value: t(contextValueLabelKey(parsed.field, parsed.value)),
  });
}
