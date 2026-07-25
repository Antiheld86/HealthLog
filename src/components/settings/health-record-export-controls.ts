/**
 * The data-selection controls of the health-record export panel: the state
 * shape, its starting values, and the wire selection they build.
 *
 * Split out of the panel component so the selection contract is testable and
 * extendable without the client component around it. The panel owns layout and
 * interaction; this module owns "which controls exist and what each one sends",
 * which is the part the export route, the aggregator and the control-gating
 * guard all have to agree with — and the part the grouped-selection work will
 * replace with a grouped registry, one file, without touching the rendering.
 */
/**
 * Every data-selection control this panel renders, as one flat state shape.
 *
 * The shape is load-bearing beyond the component: the control-gating
 * guard (`src/__tests__/doctor-report-control-gating-guard.test.ts`) walks these
 * keys, folds each one through {@link buildSelectionSections} and
 * `toDoctorReportPrefs`, and fails the build unless flipping it changes the
 * resolved selection the aggregator consumes. Adding a control here without a
 * gating path behind it is a build error, which is how eight controls that
 * changed nothing stopped being possible.
 */
export interface SectionState {
  weight: boolean;
  bp: boolean;
  pulse: boolean;
  oxygenSaturation: boolean;
  bodyFat: boolean;
  bodyComposition: boolean;
  restingHeartRate: boolean;
  hrv: boolean;
  vo2max: boolean;
  steps: boolean;
  distance: boolean;
  sleep: boolean;
  glucose: boolean;
  medList: boolean;
  compliance: boolean;
  mood: boolean;
  bmi: boolean;
  labs: boolean;
  allergies: boolean;
  familyHistory: boolean;
  mentalHealthScreeners: boolean;
}

export const DEFAULT_SECTIONS: SectionState = {
  weight: true,
  bp: true,
  pulse: true,
  oxygenSaturation: true,
  bodyFat: true,
  bodyComposition: false,
  restingHeartRate: false,
  hrv: false,
  vo2max: false,
  steps: false,
  distance: false,
  sleep: false,
  glucose: true,
  medList: true,
  compliance: true,
  mood: false, // privacy default
  bmi: true,
  labs: true,
  allergies: true,
  familyHistory: true,
  // Depression / anxiety / wellbeing / insomnia screening totals — opt-in,
  // same stance as mood.
  mentalHealthScreeners: false,
};

export function buildSelectionSections(s: SectionState) {
  return {
    vitals: {
      weight: s.weight,
      bp: s.bp,
      pulse: s.pulse,
      oxygenSaturation: s.oxygenSaturation,
      bodyFat: s.bodyFat,
      bodyComposition: s.bodyComposition,
    },
    cardioFitness: {
      restingHeartRate: s.restingHeartRate,
      hrv: s.hrv,
      vo2max: s.vo2max,
    },
    activity: {
      steps: s.steps,
      distance: s.distance,
      sleep: s.sleep,
    },
    glucose: s.glucose,
    medications: { list: s.medList, compliance: s.compliance },
    mood: s.mood,
    bmi: s.bmi,
    labs: s.labs,
    allergies: s.allergies,
    familyHistory: s.familyHistory,
    mentalHealthScreeners: s.mentalHealthScreeners,
  };
}
