/**
 * The one shipped template: what a general doctor's visit usually needs.
 *
 * It is applied on the FIRST run only, with the panel open, so the user
 * presses Generate having seen twelve named groups and an empty fenced tier.
 * That is consent to a named bundle, not a server-chosen default — nothing
 * here is applied to a stored selection, to a share link, or to any surface
 * that cannot ask a human.
 *
 * The template intersects the fenced tier at zero leaves, and
 * `report-template-purity.test.ts` fails the build if that stops being true.
 */
import { SENSITIVE_LEAF_IDS, type ReportLeafId } from "./catalogue";

/**
 * Identity and insurer (the cover page a practice files the document under),
 * the three classic vitals, weight and BMI, the glucose series and its panel,
 * labs, the drug list and adherence, allergies and past illness episodes.
 *
 * Deliberately not in it: everything a wearable produces, gait and mobility,
 * environment exposure, the per-dose administration ledger (a clinician asks
 * for adherence, not for every logged dose), the GLP-1 block, and the whole
 * fenced tier.
 */
export const STANDARD_TEMPLATE_LEAVES: readonly ReportLeafId[] = [
  "PATIENT_IDENTITY",
  "INSURANCE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "WEIGHT",
  "BODY_MASS_INDEX",
  "BLOOD_GLUCOSE",
  "GLUCOSE_PANEL",
  "LAB_RESULTS",
  "MEDICATION_LIST",
  "MEDICATION_COMPLIANCE",
  "ALLERGIES",
  "ILLNESS_EPISODES",
];

/** The template's i18n label — it is named in the panel, never anonymous. */
export const STANDARD_TEMPLATE_LABEL_KEY = "reportSelection.templateStandard";

/** Exported so the purity guard reads the same set the panel does. */
export const SENSITIVE_LEAVES = SENSITIVE_LEAF_IDS;
