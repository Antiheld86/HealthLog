/**
 * Which measurement types a doctor-report selection admits.
 *
 * Extracted from `doctor-report-data.ts` alongside the gating fix that made
 * the export panel's controls real. The aggregator is a long file that reads
 * a dozen data domains; the question "does this selection admit this
 * measurement type?" is a separate job with a separate shape, it is the one
 * the export panel's controls resolve to, and it is the piece the grouped
 * selection work will grow. It answers to two independent gates, and both
 * must pass:
 *
 *   - the per-report SECTION toggle the user chose for this artefact, and
 *   - the app-wide MODULE switch that decides whether the domain exists here
 *     at all.
 *
 * Both maps and the filter that reads them live together so a type can never
 * be gated in the query and ungated in the output, or the reverse.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/gate";
import type { DoctorReportPrefs } from "@/lib/validations/doctor-report-prefs";

/**
 * Per-measurement-type → section-toggle mapping. This is the one enforcement
 * point for "the user deselected this data": `filterMeasurementKeys` strips a
 * gated type from `measurements` + `stats`, and PDF, FHIR bundle, package,
 * clinician share view and MCP all read those two maps — so one entry here
 * gates every format at once.
 *
 * The map used to hold five types, which is why the export panel
 * could render controls for SpO₂, body fat, body composition, resting heart
 * rate, HRV, VO₂max, steps and distance and change nothing at all. Every
 * control the panel renders now resolves to a section key that appears here (or
 * to a structured section gated by name in the aggregator body), and the
 * control-gating guard test fails the build if that stops being true.
 *
 * Glucose DOES carry a `glucose` section toggle, but `BLOOD_GLUCOSE` is gated
 * at query-exclusion time (mirroring sleep) and its panel collapses via
 * `glucoseEnabled`, so it does not ride this map.
 */
export const MEASUREMENT_TYPE_SECTION: Record<string, keyof DoctorReportPrefs> =
  {
    BLOOD_PRESSURE_SYS: "bp",
    BLOOD_PRESSURE_DIA: "bp",
    WEIGHT: "weight",
    PULSE: "pulse",
    SLEEP_DURATION: "sleep",
    OXYGEN_SATURATION: "oxygenSaturation",
    BODY_FAT: "bodyFat",
    // The scale-derived composition family: everything a body-composition scale
    // reports beyond the plain weight and fat percentage.
    TOTAL_BODY_WATER: "bodyComposition",
    BONE_MASS: "bodyComposition",
    FAT_MASS: "bodyComposition",
    FAT_FREE_MASS: "bodyComposition",
    MUSCLE_MASS: "bodyComposition",
    LEAN_BODY_MASS: "bodyComposition",
    VISCERAL_FAT: "bodyComposition",
    RESTING_HEART_RATE: "restingHeartRate",
    // Both HRV estimators ride one control: SDNN and RMSSD are the same signal to
    // a reader deciding whether to hand over heart-rate variability at all.
    HEART_RATE_VARIABILITY: "hrv",
    HRV_RMSSD: "hrv",
    VO2_MAX: "vo2max",
    ACTIVITY_STEPS: "steps",
    WALKING_RUNNING_DISTANCE: "distance",
    // Screening totals. The `mentalHealth` module gate below still applies; this
    // is the per-artefact choice that gate stopped standing in for.
    PHQ9_SCORE: "mentalHealthScreeners",
    GAD7_SCORE: "mentalHealthScreeners",
    WHO5_SCORE: "mentalHealthScreeners",
    SCI_SCORE: "mentalHealthScreeners",
  };

/**
 * v1.18.0 — per-measurement-type → owning module mapping for the types that
 * carry no `sections` toggle but DO belong to a toggleable module. When the
 * module is disabled, the type is stripped from `measurements` + `stats` so the
 * series never reaches the PDF tables or a FHIR Observation.
 *
 *   - `workouts` owns the activity / movement series (steps, active energy,
 *     distance, flights, the walking-gait + stair metrics) and the
 *     training-load `STRAIN_SCORE`.
 *   - `recovery` owns the readiness signals `RECOVERY_SCORE` + `STRESS_SCORE`.
 *   - `glucose` owns the raw `BLOOD_GLUCOSE` series (the glucose panel itself is
 *     gated where it is assembled; this strips the raw rows too).
 *
 * Core clinical types (BP / weight / pulse / body-composition / vitals) carry
 * no module and are never gated here. `sleep` / `mood` / `cycle` / `labs` ride
 * the `sections` mechanism instead.
 */
export const MEASUREMENT_TYPE_MODULE: Record<string, ModuleKey> = {
  ACTIVITY_STEPS: "workouts",
  ACTIVE_ENERGY_BURNED: "workouts",
  FLIGHTS_CLIMBED: "workouts",
  WALKING_RUNNING_DISTANCE: "workouts",
  WALKING_SPEED: "workouts",
  WALKING_ASYMMETRY: "workouts",
  WALKING_STEP_LENGTH: "workouts",
  WALKING_DOUBLE_SUPPORT: "workouts",
  SIX_MINUTE_WALK_DISTANCE: "workouts",
  STAIR_ASCENT_SPEED: "workouts",
  STAIR_DESCENT_SPEED: "workouts",
  STRAIN_SCORE: "workouts",
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  BLOOD_GLUCOSE: "glucose",
  // The PHQ-9 / GAD-7 / WHO-5 / SCI screener TOTALS ride the mental-health
  // module as well as the `mentalHealthScreeners` section key above. Item-level
  // answers are never a Measurement, so they can never leak through this path
  // regardless; the total is the intended clinical artefact (total + band per
  // clinical-instruments.md §4).
  //
  // The module gate used to be the ONLY gate, on the argument that
  // the module was opt-in and therefore default-OFF. It has been default-ON
  // since v1.29.1, so that argument stopped holding and depression / anxiety
  // screening totals reached FHIR bundles, the MCP doctor-visit resource and
  // clinician share links on accounts that never chose to send them. The
  // section key restores the choice; the module gate stays as the second lock.
  PHQ9_SCORE: "mentalHealth",
  GAD7_SCORE: "mentalHealth",
  WHO5_SCORE: "mentalHealth",
  SCI_SCORE: "mentalHealth",
};

export function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
  moduleMap: Record<ModuleKey, boolean>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    const moduleKey = MEASUREMENT_TYPE_MODULE[type];
    if (moduleKey && moduleMap[moduleKey] === false) continue;
    out[type] = value;
  }
  return out;
}

/**
 * The measurement types to exclude at QUERY time for a resolved selection.
 *
 * v1.28.25 pushed the gates into the SQL because rows of a deselected section
 * were fetched only to be dropped by {@link filterMeasurementKeys} — pure dead
 * weight, and the heaviest series (minute-grain CGM) is exactly the one that
 * runs to six figures over a long window. This is output-identical by
 * construction because it reads the same two maps the filter reads.
 *
 * WEIGHT is deliberately NEVER excluded: the BMI figure (gated by
 * `sections.bmi`, not `sections.weight`) and the GLP-1 weight delta both read
 * the PRE-filter maps, so weight rows must be present even when the weight
 * section itself is off. No other gated type is read before the filter — each
 * remaining pre-filter read (sleep nights, the glucose panel, the recovery
 * summary) sits behind the same gate that drives its exclusion here.
 */
export function excludedMeasurementTypes(
  sections: DoctorReportPrefs,
  moduleMap: Record<ModuleKey, boolean>,
): MeasurementType[] {
  const excluded: MeasurementType[] = [];
  for (const [type, sectionKey] of Object.entries(MEASUREMENT_TYPE_SECTION)) {
    if (type === WEIGHT_PREFILTER_EXCEPTION) continue;
    if (sections[sectionKey] === false) excluded.push(type as MeasurementType);
  }
  // Glucose carries a section toggle but no entry in the type→section map: the
  // raw series is gated here and the panel it feeds collapses separately.
  if (sections.glucose === false) excluded.push("BLOOD_GLUCOSE");
  for (const [type, moduleKey] of Object.entries(MEASUREMENT_TYPE_MODULE)) {
    if (moduleMap[moduleKey] === false) excluded.push(type as MeasurementType);
  }
  return excluded;
}

/** The one type the query gate must keep even when its section is off. */
const WEIGHT_PREFILTER_EXCEPTION = "WEIGHT";
