/** The `t` from `useTranslations()`, injected so this stays pure. */
type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * What somebody did in your record, in a sentence.
 *
 * ## Why this exists
 *
 * The activity view renders every non-read row as one generic line: "somebody
 * made a change in your record". That was honest while sharing was read-only
 * and no delegate could make one. Now a delegate can enter a reading, a lab
 * result, an allergy, a family-history entry, an illness entry, a biomarker,
 * a tracked value, a side effect, a medication, and can mark a dose taken —
 * and "made a change" for ten different things is a way of answering nothing.
 * An owner reading this at breakfast wants the verb.
 *
 * ## Why unknown actions fall back rather than fail
 *
 * The action string comes from the audit row, which outlives this map: a
 * release that admits a twelfth verb writes rows this map has never heard of,
 * and rows written by an older image sit in the same table. So an unmapped
 * action renders the generic line it renders today. A blank row would be the
 * one outcome worse than a vague one.
 *
 * Pure and translator-injected so the mapping can be pinned without rendering
 * a card, and so the keys stay literal for the i18n call-site guard.
 */
export function recordActivityVerbLine(
  t: Translator,
  action: string,
  name: string,
): string {
  switch (action) {
    case "measurement.create":
      return t("recordSharing.activityVerb.measurementCreate", { name });
    case "labResult.create":
      return t("recordSharing.activityVerb.labResultCreate", { name });
    case "allergy.create":
      return t("recordSharing.activityVerb.allergyCreate", { name });
    case "family-history.create":
      return t("recordSharing.activityVerb.familyHistoryCreate", { name });
    case "illness.episode.create":
      return t("recordSharing.activityVerb.illnessEpisodeCreate", { name });
    case "biomarker.create":
      return t("recordSharing.activityVerb.biomarkerCreate", { name });
    case "customMetricEntry.create":
      return t("recordSharing.activityVerb.customMetricEntryCreate", { name });
    case "medication.sideEffect.create":
      return t("recordSharing.activityVerb.medicationSideEffectCreate", {
        name,
      });
    case "medication.create":
      return t("recordSharing.activityVerb.medicationCreate", { name });
    // Both spellings, and the reason is worth keeping. The web client posts to
    // `POST /api/medications/[id]/intake`, which has audited as
    // `medication.intake` since v1.0.0; `medications.intake.update` is the
    // canonical route's action and the one the plan's copy deck named. Mapping
    // only the second meant the single most-used delegated act — a caregiver
    // marking a dose — rendered as the generic "made a change" for the person
    // whose tablets they are.
    case "medication.intake":
    case "medications.intake.update":
      return t("recordSharing.activityVerb.medicationIntake", { name });
    // A batch post is still readings arriving; the owner does not care that the
    // client sent them together.
    case "measurement.create.batch":
      return t("recordSharing.activityVerb.measurementCreate", { name });
    default:
      return t("recordSharing.activity.acted", { name });
  }
}
