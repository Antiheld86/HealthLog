/**
 * The recording device's own rhythm verdict, and the two things every ECG
 * surface needs to say about it.
 *
 * The list, the detail page and the cross-link card all render this value and
 * all three used to carry their own copy of the label map. It is one map now,
 * so a fourth surface cannot introduce a fifth wording.
 *
 * HealthLog produces NO verdict of its own — no measured intervals, no
 * beat/P/QRS/T annotation, no risk score. Everything here is the device's
 * result, passed through.
 */
export type EcgClassification =
  "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;

/** i18n key per device verdict, under `insights.ecg.result.*`. */
export const ECG_RESULT_LABEL_KEYS: Record<string, string> = {
  IRREGULAR: "insights.ecg.result.irregular",
  NOT_DETECTED: "insights.ecg.result.notDetected",
  INCONCLUSIVE: "insights.ecg.result.inconclusive",
};

/** Resolve the device verdict to its localised label, or null when unset. */
export function ecgResultLabel(
  classification: EcgClassification,
  t: (key: string) => string,
): string | null {
  if (!classification) return null;
  const key = ECG_RESULT_LABEL_KEYS[classification];
  return key ? t(key) : null;
}

/** A non-normal device result carries the "discuss with a clinician" note. */
export function isNonNormalEcg(classification: EcgClassification): boolean {
  return classification === "IRREGULAR" || classification === "INCONCLUSIVE";
}
