/**
 * Glucose Observations: the per-context reading and the clinical panel
 * (time-in-range, mean, GMI, estimated A1C, variability) the one
 * literature-locked engine computes for the report period.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  resolveGlucoseUnit,
  convertGlucose,
  type GlucoseUnit,
} from "@/lib/glucose";
import {
  LOINC_SYSTEM,
  GLUCOSE_LOINC,
  GLUCOSE_TIR_LOINC,
  GLUCOSE_GMI_LOINC,
  GLUCOSE_MEAN_LOINC,
  GLUCOSE_EA1C_LOINC,
} from "@/lib/fhir/loinc-map";
import { ucumQuantity } from "@/lib/fhir/ucum";
import type { FhirObservation } from "@/lib/fhir/types";
import {
  categoryConcept,
  patientRef,
  reportingPeriod,
} from "@/lib/fhir/resources/common";

/**
 * The time-in-range band, stated in the unit the reader uses. The band itself
 * is fixed at 70–180 mg/dL [Battelino 2019]; only its presentation converts,
 * exactly as the sibling mean-glucose value does. Printing "70–180 mg/dL" to a
 * mmol/L reader hands them a number they cannot compare against their own.
 */
function timeInRangeDisplay(unit: GlucoseUnit): string {
  const low = convertGlucose(70, unit);
  const high = convertGlucose(180, unit);
  return `Glucose time in range (${low}–${high} ${unit})`;
}

/**
 * One Observation per recorded glucose context, valued in the user's display
 * unit. The value is the context's LATEST reading but the code is a context
 * summary, so it carries the reporting period rather than a reading instant.
 */
export function glucoseContextObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const observations: FhirObservation[] = [];
  for (const [ctx, stat] of Object.entries(data.glucoseStats)) {
    const map = GLUCOSE_LOINC[ctx];
    if (!map) continue;
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("laboratory")],
      code: {
        coding: [
          { system: LOINC_SYSTEM, code: map.loinc, display: map.display },
        ],
        text: map.display,
      },
      subject: patientRef,
      effectivePeriod: reportingPeriod(data),
      valueQuantity: ucumQuantity(
        convertGlucose(stat.latest, glucoseUnit),
        glucoseUnit,
      ),
    });
  }
  return observations;
}

/**
 * The clinical glucose panel (v1.18.0). Emitted only when readings exist — the
 * aggregator zeroes the panel when the glucose module is off, so an absent
 * panel means the module is off OR there is no data. Each metric carries its
 * published LOINC where one exists; the coefficient of variation has none and
 * rides a `survey` text-only concept.
 */
export function glucoseClinicalObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const clinical = data.glucoseClinical;
  if (!clinical || clinical.readingCount <= 0) return [];

  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const period = reportingPeriod(data);
  const observations: FhirObservation[] = [];

  const push = (opts: {
    loinc?: string;
    text: string;
    value: number;
    unit: string;
    survey?: boolean;
  }) => {
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept(opts.survey ? "survey" : "laboratory")],
      code: opts.loinc
        ? {
            coding: [
              { system: LOINC_SYSTEM, code: opts.loinc, display: opts.text },
            ],
            text: opts.text,
          }
        : { text: opts.text },
      subject: patientRef,
      effectivePeriod: period,
      valueQuantity: ucumQuantity(opts.value, opts.unit),
      ...(clinical.isSpotEstimate
        ? {
            note: [
              {
                text: "Spot-reading estimate from individual measurements, not a continuous-monitor profile.",
              },
            ],
          }
        : {}),
    });
  };

  if (clinical.distribution) {
    push({
      loinc: GLUCOSE_TIR_LOINC,
      text: timeInRangeDisplay(glucoseUnit),
      value: Math.round(clinical.distribution.tir * 1000) / 10,
      unit: "%",
    });
  }
  if (clinical.meanMgdl !== null) {
    push({
      loinc: GLUCOSE_MEAN_LOINC,
      text: "Mean glucose",
      value: convertGlucose(clinical.meanMgdl, glucoseUnit),
      unit: glucoseUnit,
    });
  }
  if (clinical.gmi !== null) {
    push({
      loinc: GLUCOSE_GMI_LOINC,
      text: "Glucose Management Indicator (GMI)",
      value: Math.round(clinical.gmi * 10) / 10,
      unit: "%",
    });
  }
  if (clinical.estimatedA1c !== null) {
    push({
      loinc: GLUCOSE_EA1C_LOINC,
      text: "Estimated A1C",
      value: Math.round(clinical.estimatedA1c * 10) / 10,
      unit: "%",
    });
  }
  if (clinical.variability !== null) {
    push({
      text: "Glucose variability (coefficient of variation)",
      value: Math.round(clinical.variability.cv * 10) / 10,
      unit: "%",
      survey: true,
    });
  }

  return observations;
}
