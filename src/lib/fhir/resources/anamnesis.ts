import type { DoctorReportData } from "@/lib/doctor-report-data";
import { LOINC_SYSTEM } from "@/lib/fhir/loinc-map";
import {
  SNOMED_SYSTEM,
  categoryConcept,
  patientRef,
} from "@/lib/fhir/resources/common";
import type { FhirCodeableConcept, FhirObservation } from "@/lib/fhir/types";
import type { HealthProfileFactKind } from "@/lib/validations/health-profile-facts";

const DATA_ABSENT_REASON_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/data-absent-reason";

interface AnamnesisFactDefinition {
  code: string;
  display: string;
  valueDisplay: Readonly<Record<string, string>>;
  valueCoding?: Readonly<Record<string, FhirCodeableConcept>>;
}

/**
 * The source values are deliberately broader than several published value
 * sets. Only values with an exact SNOMED CT match receive a value coding; the
 * remaining value stays as `CodeableConcept.text` rather than asserting a more
 * specific clinical meaning than the user recorded.
 */
const FACT_DEFINITIONS: Readonly<
  Record<HealthProfileFactKind, AnamnesisFactDefinition>
> = {
  SMOKING_STATUS: {
    code: "72166-2",
    display: "Tobacco smoking status",
    valueDisplay: {
      NEVER: "Never smoker",
      FORMER: "Former smoker",
      CURRENT: "Current smoker",
    },
    valueCoding: {
      NEVER: {
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: "266919005",
            display: "Never smoked tobacco",
          },
        ],
      },
      FORMER: {
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: "8517006",
            display: "Ex-smoker",
          },
        ],
      },
      CURRENT: {
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: "77176002",
            display: "Smoker",
          },
        ],
      },
    },
  },
  ALCOHOL_PATTERN: {
    code: "11331-6",
    display: "History of alcohol use",
    valueDisplay: {
      NONE: "None",
      OCCASIONAL: "Occasional",
      WEEKLY: "Weekly",
      MOST_DAYS: "Most days",
    },
  },
  SHIFT_SCHEDULE: {
    code: "74159-5",
    display: "Work schedule NIOSH",
    valueDisplay: {
      NONE: "No shift work",
      FIXED_SHIFT: "Fixed shift",
      ROTATING: "Rotating shifts",
    },
  },
};

function absentReason(unreadable: boolean): FhirCodeableConcept {
  return {
    coding: [
      {
        system: DATA_ABSENT_REASON_SYSTEM,
        code: unreadable ? "error" : "unknown",
        display: unreadable ? "Error" : "Unknown",
      },
    ],
    text: unreadable ? "Recorded value is unreadable" : "Not recorded",
  };
}

/**
 * Emit all three facts whenever ANAMNESIS was selected. A missing or unreadable
 * value still produces its Observation with a distinct data-absent reason, so
 * a recipient can distinguish it from a leaf the user did not select.
 */
export function anamnesisObservationsFromReportData(
  data: DoctorReportData,
): FhirObservation[] {
  const anamnesis = data.anamnesis;
  if (!anamnesis) return [];

  const values: Record<HealthProfileFactKind, string | null> = {
    SMOKING_STATUS: anamnesis.smokingStatus,
    ALCOHOL_PATTERN: anamnesis.alcoholPattern,
    SHIFT_SCHEDULE: anamnesis.shiftSchedule,
  };
  const kinds: readonly HealthProfileFactKind[] = [
    "SMOKING_STATUS",
    "ALCOHOL_PATTERN",
    "SHIFT_SCHEDULE",
  ];

  return kinds.map((kind, index) => {
    const definition = FACT_DEFINITIONS[kind];
    const value = values[kind];
    const unreadable = anamnesis.unreadableFacts.includes(kind);
    const valueConcept =
      value && !unreadable
        ? {
            ...(definition.valueCoding?.[value] ?? {}),
            text: definition.valueDisplay[value] ?? value,
          }
        : undefined;

    return {
      resourceType: "Observation",
      id: `obs-anamnesis-${index + 1}`,
      status: "final",
      category: [categoryConcept("social-history")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: definition.code,
            display: definition.display,
          },
        ],
        text: definition.display,
      },
      subject: patientRef,
      ...(valueConcept
        ? { valueCodeableConcept: valueConcept }
        : { dataAbsentReason: absentReason(unreadable) }),
      ...(unreadable
        ? { note: [{ text: "The recorded value could not be read." }] }
        : {}),
    };
  });
}

/** Raw narrative text; the document builder performs XHTML escaping once. */
export function anamnesisNarrativeFromReportData(
  data: DoctorReportData,
): string | null {
  const anamnesis = data.anamnesis;
  if (!anamnesis) return null;
  const factText = (
    kind: HealthProfileFactKind,
    value: string | null,
  ): string => {
    if (anamnesis.unreadableFacts.includes(kind)) return "unreadable";
    if (!value) return "not recorded";
    return FACT_DEFINITIONS[kind].valueDisplay[value] ?? value;
  };
  const conditions = anamnesis.conditionsUnreadable
    ? "unreadable"
    : (anamnesis.conditions ?? "not recorded");

  return [
    `Conditions: ${conditions}.`,
    `Smoking status: ${factText("SMOKING_STATUS", anamnesis.smokingStatus)}.`,
    `Alcohol pattern: ${factText("ALCOHOL_PATTERN", anamnesis.alcoholPattern)}.`,
    `Shift schedule: ${factText("SHIFT_SCHEDULE", anamnesis.shiftSchedule)}.`,
  ].join(" ");
}
