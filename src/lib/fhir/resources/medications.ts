/**
 * `MedicationStatement` (one per active medication) and
 * `MedicationAdministration` (one per acted intake), with their additive
 * ATC / RxNorm codings and the dose / route / site SNOMED anchors.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { UCUM_SYSTEM } from "@/lib/fhir/loinc-map";
import type {
  FhirCodeableConcept,
  FhirDosage,
  FhirMedicationAdministration,
  FhirMedicationStatement,
} from "@/lib/fhir/types";
import {
  ATC_BFARM_SYSTEM,
  ATC_SYSTEM,
  RXNORM_SYSTEM,
  SNOMED_SYSTEM,
  patientRef,
  type FhirBuildOptions,
} from "@/lib/fhir/resources/common";

/**
 * Build a `medicationCodeableConcept` from a medication's free-text name
 * plus its optional user-asserted codes. ATC is emitted first (primary),
 * RxNorm second (secondary); both are omitted when NULL, collapsing to
 * exactly the pre-v1.9.0 `{ text }` shape. Never machine-guesses a code.
 * When `germanAtc` is set, the same ATC leaf code is also published under
 * the BfArM URI AFTER the WHO entry — additive, never reordering WHO.
 */
function medicationConcept(
  name: string,
  atcCode: string | null | undefined,
  rxNormCode: string | null | undefined,
  germanAtc: boolean,
): FhirCodeableConcept {
  const coding: NonNullable<FhirCodeableConcept["coding"]> = [];
  if (atcCode) {
    coding.push({ system: ATC_SYSTEM, code: atcCode, display: name });
    if (germanAtc) {
      coding.push({ system: ATC_BFARM_SYSTEM, code: atcCode, display: name });
    }
  }
  if (rxNormCode) {
    coding.push({ system: RXNORM_SYSTEM, code: rxNormCode });
  }
  return coding.length > 0 ? { coding, text: name } : { text: name };
}

/**
 * v1.9.0 — the dose units HealthLog stores, normalised to their UCUM symbol.
 * The display `unit` is always the user's original string; the UCUM `code` is
 * set only for an unambiguous mapping so a consumer that resolves UCUM never
 * sees a guessed code. An unmapped unit keeps just the human-readable `unit`.
 */
const UCUM_DOSE_CODES: Record<string, string> = {
  mg: "mg",
  g: "g",
  mcg: "ug",
  µg: "ug",
  ug: "ug",
  ml: "mL",
  mL: "mL",
};

function doseQuantity(
  value: number,
  unit: string,
): { value: number; unit: string; system?: string; code?: string } {
  const ucum = UCUM_DOSE_CODES[unit];
  return ucum
    ? { value, unit, system: UCUM_SYSTEM, code: ucum }
    : { value, unit };
}

/**
 * Route of administration derived from the medication's delivery form,
 * carrying an additive SNOMED CT `coding` alongside the existing `.text`
 * anchor. HealthLog injections are subcutaneous (the injection-site picker
 * exists for the self-injection workflow), so `INJECTION` maps to the
 * subcutaneous route. Returns `undefined` for an unknown / absent form so no
 * empty route is emitted.
 */
const ROUTE_SNOMED: Record<string, { code: string; display: string }> = {
  ORAL: { code: "26643006", display: "Oral route" },
  INJECTION: { code: "34206005", display: "Subcutaneous route" },
};

function routeConcept(
  deliveryForm: string | null,
): FhirCodeableConcept | undefined {
  const text =
    deliveryForm === "ORAL"
      ? "Oral"
      : deliveryForm === "INJECTION"
        ? "Injection"
        : undefined;
  if (!text) return undefined;
  const snomed = ROUTE_SNOMED[deliveryForm as string];
  return snomed
    ? {
        coding: [
          { system: SNOMED_SYSTEM, code: snomed.code, display: snomed.display },
        ],
        text,
      }
    : { text };
}

/**
 * Administration body-site keyed on the raw `InjectionSite` enum value,
 * carrying an additive SNOMED CT body-region `coding` alongside the `.text`
 * anchor. The map collapses the eight enum members to three gross body-region
 * concepts (abdomen / thigh / upper arm); laterality (left/right) and the
 * abdominal quadrant are NOT lateralised SNOMED concepts here — they are
 * preserved verbatim in the human-readable `.text` (the raw enum value), so
 * no information is lost.
 */
const SITE_SNOMED: Record<string, { code: string; display: string }> = {
  ABDOMEN_LEFT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_RIGHT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_UPPER_LEFT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_UPPER_RIGHT: { code: "818983003", display: "Abdomen structure" },
  THIGH_LEFT: { code: "68367000", display: "Thigh structure" },
  THIGH_RIGHT: { code: "68367000", display: "Thigh structure" },
  UPPER_ARM_LEFT: { code: "40983000", display: "Structure of upper arm" },
  UPPER_ARM_RIGHT: { code: "40983000", display: "Structure of upper arm" },
};

function siteConcept(injectionSite: string): FhirCodeableConcept {
  const snomed = SITE_SNOMED[injectionSite];
  // Preserve the full enum value (incl. laterality) as the readable anchor.
  const text = injectionSite;
  return snomed
    ? {
        coding: [
          { system: SNOMED_SYSTEM, code: snomed.code, display: snomed.display },
        ],
        text,
      }
    : { text };
}

/**
 * Emit one `MedicationStatement` per active medication. Ids run `med-1..N`.
 */
export function medicationStatementsFromReportData(
  data: DoctorReportData,
  options: FhirBuildOptions = {},
): FhirMedicationStatement[] {
  const germanAtc = options.germanAtc ?? false;
  const statements: FhirMedicationStatement[] = [];
  let medSeq = 0;
  for (const med of data.medications) {
    medSeq += 1;
    const stmt: FhirMedicationStatement = {
      resourceType: "MedicationStatement",
      id: `med-${medSeq}`,
      status: "active",
      medicationCodeableConcept: medicationConcept(
        med.name,
        med.atcCode,
        med.rxNormCode,
        germanAtc,
      ),
      subject: patientRef,
    };
    if (med.dose) stmt.dosage = [{ text: med.dose }];
    statements.push(stmt);
  }
  return statements;
}

/**
 * Emit one `MedicationAdministration` per acted intake: `completed` (taken)
 * or `not-done` (explicitly skipped). Pending / missed slots and soft-deleted
 * tombstones are excluded upstream by the aggregator. The concept reuses the
 * same ATC/RxNorm coding as the statement so each administration is
 * self-describing without resolving a reference (no `partOf` / `request`
 * coupling). A `dosage` is emitted ONLY when a structured `dose` Quantity is
 * available; a dosage with only `.text` would violate the R4 dose-or-rate
 * invariant. Ids run `medadmin-1..N`.
 */
export function medicationAdministrationsFromReportData(
  data: DoctorReportData,
  options: FhirBuildOptions = {},
): FhirMedicationAdministration[] {
  const germanAtc = options.germanAtc ?? false;
  const administrations: FhirMedicationAdministration[] = [];
  let adminSeq = 0;
  for (const admin of data.medicationAdministrations ?? []) {
    adminSeq += 1;
    const resource: FhirMedicationAdministration = {
      resourceType: "MedicationAdministration",
      id: `medadmin-${adminSeq}`,
      status: admin.status,
      medicationCodeableConcept: medicationConcept(
        admin.medicationName,
        admin.atcCode,
        admin.rxNormCode,
        germanAtc,
      ),
      subject: patientRef,
      effectiveDateTime: admin.effectiveAt,
    };

    // Dosage: only when a structured dose Quantity exists. Carry the
    // free-text dose + route + site alongside it. Route and site each carry
    // an additive SNOMED coding plus the existing `.text` anchor.
    if (admin.dose) {
      const dosage: FhirDosage = {
        dose: doseQuantity(admin.dose.value, admin.dose.unit),
      };
      if (admin.doseText) dosage.text = admin.doseText;
      const route = routeConcept(admin.deliveryForm);
      if (route) dosage.route = route;
      if (admin.injectionSite) dosage.site = siteConcept(admin.injectionSite);
      resource.dosage = dosage;
    }

    administrations.push(resource);
  }
  return administrations;
}
