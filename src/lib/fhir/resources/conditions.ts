/**
 * `Condition` + bounding `Encounter` per illness / condition episode.
 *
 * HealthLog records a patient-kept condition journal; it is NOT a diagnosing
 * device and asserts no specific ICD/SNOMED diagnosis. The user's own label
 * rides `code.text`; the coded `code` carries the BROAD SNOMED CT category for
 * the episode's `IllnessType`, with the generic "Disease" root as the honest
 * fallback for an unknown / future type.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { ILLNESS_TYPE_SNOMED } from "@/lib/fhir/illness-snomed";
import type {
  FhirCodeableConcept,
  FhirCondition,
  FhirEncounter,
} from "@/lib/fhir/types";
import { SNOMED_SYSTEM, patientRef } from "@/lib/fhir/resources/common";

/** SNOMED CT "Disease (disorder)" — the generic, non-diagnostic root concept. */
const DISEASE_SNOMED = { code: "64572001", display: "Disease" } as const;

/** R4 `Condition.clinicalStatus` concept for the given resolution state. */
function conditionClinicalStatus(resolved: boolean): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: resolved ? "resolved" : "active",
      },
    ],
  };
}

/**
 * v1.18.1 P4 — emit one `Condition` per illness/condition episode plus a
 * bounding `Encounter`. Absent unless the illness module is enabled AND the
 * window held an episode (the aggregator only populates `illnessEpisodes`
 * then). Ids run `condition-1..N` / `encounter-1..N`; the Encounter references
 * its Condition so a clinician sees the time-boxed episode.
 */
export function conditionsFromReportData(data: DoctorReportData): {
  conditions: FhirCondition[];
  encounters: FhirEncounter[];
} {
  const episodes = data.illnessEpisodes;
  if (!episodes || episodes.length === 0) {
    return { conditions: [], encounters: [] };
  }
  const conditions: FhirCondition[] = [];
  const encounters: FhirEncounter[] = [];
  let seq = 0;
  for (const ep of episodes) {
    seq += 1;
    const conditionId = `condition-${seq}`;
    const resolved = ep.resolvedAt !== null;
    conditions.push({
      resourceType: "Condition",
      id: conditionId,
      clinicalStatus: conditionClinicalStatus(resolved),
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            // Patient-reported journal entry → "unconfirmed", never a
            // clinician-confirmed diagnosis.
            code: "unconfirmed",
          },
        ],
      },
      category: [
        {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/condition-category",
              code: "problem-list-item",
            },
          ],
          // The journal's broad class as a human-readable category label.
          text: ep.type,
        },
      ],
      code: {
        // Broad SNOMED CT category for the journal type; the generic "Disease"
        // root is the honest fallback for an unknown / future type. NEVER a
        // specific diagnosis — the user's own label stays on `.text`.
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: (ILLNESS_TYPE_SNOMED[ep.type] ?? DISEASE_SNOMED).code,
            display: (ILLNESS_TYPE_SNOMED[ep.type] ?? DISEASE_SNOMED).display,
          },
        ],
        text: ep.label,
      },
      subject: patientRef,
      onsetDateTime: ep.onsetAt,
      ...(ep.resolvedAt ? { abatementDateTime: ep.resolvedAt } : {}),
      note: [
        {
          text: `Self-recorded ${ep.lifecycle.toLowerCase().replace(/_/g, " ")} condition journal entry; patient-reported, not a clinical diagnosis.`,
        },
      ],
    });
    encounters.push({
      resourceType: "Encounter",
      id: `encounter-${seq}`,
      status: resolved ? "finished" : "in-progress",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      subject: patientRef,
      period: {
        start: ep.onsetAt,
        ...(ep.resolvedAt ? { end: ep.resolvedAt } : {}),
      },
      reasonReference: [{ reference: `Condition/${conditionId}` }],
    });
  }
  return { conditions, encounters };
}
