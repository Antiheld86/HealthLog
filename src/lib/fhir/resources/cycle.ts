/**
 * v1.15.0 — the cycle / reproductive-health Observations from the opt-in cycle
 * summary: LMP (LOINC 8665-2, a date value), average cycle length (64700-8,
 * days), average period length (64698-4, days), and the current phase
 * (text-only survey finding). Absent when the aggregator carried no cycle
 * summary (toggle off or no observed cycle). Ids run `obs-cycle-N` so they
 * never collide with the main `obs-N` sequence.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  LOINC_SYSTEM,
  LMP_LOINC,
  CYCLE_LENGTH_LOINC,
  PERIOD_LENGTH_LOINC,
} from "@/lib/fhir/loinc-map";
import { ucumQuantity } from "@/lib/fhir/ucum";
import type { FhirObservation } from "@/lib/fhir/types";
import {
  categoryConcept,
  patientRef,
  reportingPeriod,
} from "@/lib/fhir/resources/common";

/**
 * Phase → display string for the current-phase Observation. The four cycle
 * phases have no single published LOINC answer-list term we commit to, so the
 * phase rides a text-only concept under the `survey` category (a clinician's
 * viewer reads it as a descriptive finding, not a coded diagnosis), mirroring
 * the wellness-score stance.
 */
const CYCLE_PHASE_DISPLAY: Record<string, string> = {
  MENSTRUAL: "Menstrual phase",
  FOLLICULAR: "Follicular phase",
  OVULATORY: "Ovulatory phase",
  LUTEAL: "Luteal phase",
};

export function cycleObservationsFromReportData(
  data: DoctorReportData,
): FhirObservation[] {
  const cycle = data.cycle;
  if (!cycle) return [];
  const observations: FhirObservation[] = [];
  let seq = 0;
  const next = () => `obs-cycle-${(seq += 1)}`;
  // Every cycle figure is derived across the whole window, not read at its
  // last instant.
  const effectivePeriod = reportingPeriod(data);

  if (cycle.lastPeriodStart) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: LMP_LOINC,
            display: "Last menstrual period start date",
          },
        ],
        text: "Last menstrual period (LMP)",
      },
      subject: patientRef,
      effectivePeriod,
      // LMP is a date value; emit the YYYY-MM-DD as a FHIR `date`.
      valueDateTime: cycle.lastPeriodStart,
    });
  }

  if (cycle.averageCycleLengthDays !== null) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: CYCLE_LENGTH_LOINC,
            display: "Menstrual cycle length",
          },
        ],
        text: "Average menstrual cycle length",
      },
      subject: patientRef,
      effectivePeriod,
      valueQuantity: ucumQuantity(cycle.averageCycleLengthDays, "d"),
      ...(cycle.cycleLengthVariabilityDays !== null
        ? {
            note: [
              {
                text: `Cycle-length variability (median absolute deviation): ±${cycle.cycleLengthVariabilityDays} days over ${cycle.observedCycleCount} observed cycle(s).`,
              },
            ],
          }
        : {}),
    });
  }

  if (cycle.averagePeriodLengthDays !== null) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: PERIOD_LENGTH_LOINC,
            display: "Length of menses",
          },
        ],
        text: "Average period length",
      },
      subject: patientRef,
      effectivePeriod,
      valueQuantity: ucumQuantity(cycle.averagePeriodLengthDays, "d"),
    });
  }

  if (cycle.currentPhase) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: { text: "Current menstrual cycle phase" },
      subject: patientRef,
      effectivePeriod,
      valueString:
        CYCLE_PHASE_DISPLAY[cycle.currentPhase] ?? cycle.currentPhase,
      note: [
        {
          text: "Phase derived from logged cycle boundaries; descriptive, not a clinical assessment.",
        },
      ],
    });
  }

  return observations;
}
