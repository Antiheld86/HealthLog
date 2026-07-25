/**
 * v1.4.25 W6c — per-user Doctor-Report section toggles.
 *
 * Persisted as a Json blob on `User.doctorReportPrefsJson`. Null = the
 * documented defaults (every section ON except mood). The dialog reads
 * the row, lets the user flip checkboxes, and writes the chosen shape
 * back. The PDF generator + the report aggregator both consult the
 * shape: aggregator drops mood data entirely when `mood = false` so the
 * data never leaves the DB row (privacy-by-default), and the generator
 * skips each section whose flag is false at render time.
 *
 * The shape is intentionally additive — every new data type added to the
 * report grows the schema with a new optional flag and a new entry in
 * `DEFAULT_DOCTOR_REPORT_PREFS`. Forward-compat: an unknown / drifted
 * shape falls back to defaults rather than throwing.
 */
import { z } from "zod/v4";

/**
 * Section toggle schema. Every key is optional so a partial update from
 * the dialog (e.g., "the user only flipped mood") doesn't have to
 * re-state every other flag. The route layer fills missing keys from the
 * defaults before persisting so the column shape stays stable.
 */
export const doctorReportPrefsSchema = z
  .object({
    bp: z.boolean(),
    weight: z.boolean(),
    pulse: z.boolean(),
    bmi: z.boolean(),
    mood: z.boolean(),
    medicationList: z.boolean(),
    compliance: z.boolean(),
    sleep: z.boolean(),
    glucose: z.boolean(),
    cycle: z.boolean(),
    labs: z.boolean(),
    allergies: z.boolean(),
    familyHistory: z.boolean(),
    oxygenSaturation: z.boolean(),
    bodyFat: z.boolean(),
    bodyComposition: z.boolean(),
    restingHeartRate: z.boolean(),
    hrv: z.boolean(),
    vo2max: z.boolean(),
    steps: z.boolean(),
    distance: z.boolean(),
    mentalHealthScreeners: z.boolean(),
  })
  .partial();

export type DoctorReportPrefsInput = z.infer<typeof doctorReportPrefsSchema>;

/**
 * Fully-resolved section toggles. Every key required so the consumers
 * (PDF renderer + aggregator) don't have to thread an "is this key
 * present?" check through their render paths.
 */
export interface DoctorReportPrefs {
  bp: boolean;
  weight: boolean;
  pulse: boolean;
  bmi: boolean;
  mood: boolean;
  /**
   * The active-medication list (names, doses, schedules) and the
   * per-dose administration ledger. Previously exported unconditionally while
   * the only medication control folded into {@link DoctorReportPrefs.compliance}.
   */
  medicationList: boolean;
  compliance: boolean;
  sleep: boolean;
  glucose: boolean;
  cycle: boolean;
  labs: boolean;
  allergies: boolean;
  familyHistory: boolean;
  /**
   * The measurement groups the export panel has always rendered a
   * control for but nothing gated. Each one now drives
   * `MEASUREMENT_TYPE_SECTION` in the aggregator, so it reaches PDF, FHIR and
   * the package alike.
   */
  oxygenSaturation: boolean;
  bodyFat: boolean;
  bodyComposition: boolean;
  restingHeartRate: boolean;
  hrv: boolean;
  vo2max: boolean;
  steps: boolean;
  distance: boolean;
  /**
   * PHQ-9 / GAD-7 / WHO-5 / SCI screening totals. Depression,
   * anxiety, wellbeing and insomnia instruments: opt-in per artefact like
   * mood, never carried by an absent key.
   */
  mentalHealthScreeners: boolean;
}

/**
 * Defaults applied when the user has never opened the dialog. Every
 * section is ON by default EXCEPT mood, which is opt-in per the maintainer's
 * privacy directive (2026-05-14): mental-health data should never appear
 * in a clinical PDF the user didn't explicitly check.
 */
export const DEFAULT_DOCTOR_REPORT_PREFS: DoctorReportPrefs = {
  bp: true,
  weight: true,
  pulse: true,
  bmi: true,
  mood: false, // privacy default per the maintainer
  // The medication list has always ridden along; the flag exists so the panel's
  // single "medications" control can actually withhold it, not to change what a
  // caller that omits the key receives.
  medicationList: true,
  compliance: true,
  sleep: true,
  // Glucose the user recorded to share with a clinician — ON by default,
  // like BP / weight / labs. The per-report toggle lets a diabetic user
  // withhold glucose from a SPECIFIC shared report without disabling the
  // glucose module app-wide (default-on preserves the pre-toggle behaviour,
  // where glucose always rendered).
  glucose: true,
  // Cycle data is opt-in: a user sharing a BP report with a cardiologist
  // should not auto-leak reproductive data. Same privacy stance as mood.
  cycle: false,
  // Lab results the user recorded for exactly this purpose — sharing
  // bloodwork with a clinician. ON by default, like BP / weight.
  labs: true,
  // Structured allergy / intolerance records — the section every clinical
  // intake asks for first. Reference data recorded to share, ON by default
  // like labs.
  allergies: true,
  // Structured family history — same stance as allergies.
  familyHistory: true,
  // The measurement groups that gained a real gate here. They default ON
  // because that is what an omitted key has always produced; the point of the
  // flags is that a caller who switches one OFF is now obeyed. The web panel
  // sends every one of them explicitly.
  oxygenSaturation: true,
  bodyFat: true,
  bodyComposition: true,
  restingHeartRate: true,
  hrv: true,
  vo2max: true,
  steps: true,
  distance: true,
  // Mental-health screening totals are opt-in per artefact, same stance as
  // mood: PHQ-9 and GAD-7 are depression and anxiety instruments and must not
  // leave the instance because a caller omitted a key. The `mentalHealth`
  // module gate still applies on top — it just no longer stands alone, having
  // been default-ON since v1.29.1.
  mentalHealthScreeners: false,
};

/**
 * The "no section" shape — every toggle OFF. A share link that carries ONLY
 * documents (the "share this document, not the whole record" flow) persists
 * this so the clinician view resolves to an empty report scope and NO health
 * data is ever aggregated for it. Distinct from the null / `{}` case, which
 * resolves to {@link DEFAULT_DOCTOR_REPORT_PREFS} (a full record share).
 */
export const EMPTY_DOCTOR_REPORT_PREFS: DoctorReportPrefs = {
  bp: false,
  weight: false,
  pulse: false,
  bmi: false,
  mood: false,
  medicationList: false,
  compliance: false,
  sleep: false,
  glucose: false,
  cycle: false,
  labs: false,
  allergies: false,
  familyHistory: false,
  oxygenSaturation: false,
  bodyFat: false,
  bodyComposition: false,
  restingHeartRate: false,
  hrv: false,
  vo2max: false,
  steps: false,
  distance: false,
  mentalHealthScreeners: false,
};

/**
 * Whether any report section is enabled. A resolved prefs object with every
 * flag OFF means "no health report" — the load-bearing signal a documents-only
 * share reads to serve zero metrics. The clinician-view data loader gates the
 * whole doctor-report aggregation on this: false ⇒ never touch the DB for
 * health data.
 */
export function hasAnyReportSection(prefs: DoctorReportPrefs): boolean {
  return Object.values(prefs).some(Boolean);
}

/**
 * Parse a row's `doctorReportPrefsJson` Json blob into a typed
 * `DoctorReportPrefs`, falling back to the documented defaults when the
 * row is null OR the persisted shape has drifted (a forward-compat field
 * rename, an admin-side hand-edit, etc.). Missing keys are filled from
 * the defaults so callers always get a fully-resolved object.
 */
export function parseDoctorReportPrefs(raw: unknown): DoctorReportPrefs {
  if (raw == null) return { ...DEFAULT_DOCTOR_REPORT_PREFS };
  const parsed = doctorReportPrefsSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_DOCTOR_REPORT_PREFS };
  return {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...parsed.data,
  };
}

/**
 * Resolve a partial input (typically from a PUT body) into the full
 * canonical shape, layering the supplied keys over the current
 * persisted row (or defaults when null). Keeps the route layer free of
 * merge plumbing.
 */
export function resolveDoctorReportPrefs(
  current: unknown,
  incoming: DoctorReportPrefsInput,
): DoctorReportPrefs {
  const base = parseDoctorReportPrefs(current);
  return { ...base, ...incoming };
}
