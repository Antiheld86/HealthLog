/**
 * v1.18.8 — HealthLog `IllnessType` → broad SNOMED CT category concept.
 *
 * The condition journal records PATIENT-REPORTED categories, not clinician
 * diagnoses. Each `IllnessType` therefore maps to a BROAD, well-known SNOMED
 * CT category concept (a disease class), NEVER a specific diagnosis. The
 * user's own free-text label rides `Condition.code.text` and the broad class
 * is also surfaced as `Condition.category.text`; this coded concept is the
 * honest middle ground — a downstream system reads "an infectious-disease
 * class condition the patient reported", not a fabricated specific diagnosis.
 *
 * The builder keeps `verificationStatus: unconfirmed` and the
 * "patient-reported, not a clinical diagnosis" note on every Condition, so the
 * category coding can never be mistaken for a confirmed finding.
 *
 * Concept ids are REFERENCED (not redistributed) per the SNOMED CT licence,
 * matching the existing route / body-site coding convention in `resources.ts`.
 * Each id below is a real SNOMED CT International concept; the category-level
 * choice is deliberate (a class, not a leaf disorder).
 *
 * Systems: SNOMED CT — http://snomed.info/sct
 *
 * No ICD-10 coding is emitted: a category-level ICD-10 chapter (e.g. "A00–B99
 * Certain infectious diseases") is a chapter RANGE, not a billable leaf code,
 * and asserting a single chapter code per journal category would over-state
 * what the patient recorded. SNOMED-only is the honest choice here.
 */

/** SNOMED CT category concept for a patient-reported illness class. */
export interface IllnessSnomedCategory {
  code: string;
  display: string;
}

/**
 * `IllnessType` enum value → broad SNOMED CT category concept.
 *
 *  - INFECTION     → 40733004  "Infectious disease (disorder)"
 *  - ALLERGY       → 473011001 "Allergic condition (finding)"
 *                    (106190000 "Allergy", used before, is inactive since
 *                    2013)
 *  - INJURY        → 417163006 "Traumatic or non-traumatic injury (disorder)"
 *                    (spans both, the honest broad class for a journal entry)
 *  - MENTAL_HEALTH → 74732009  "Mental disorder (disorder)"
 *  - AUTOIMMUNE    → 85828009  "Autoimmune disease (disorder)"
 *  - CHRONIC       → 27624003  "Chronic disease (disorder)"
 *  - OTHER         → 64572001  "Disease (disorder)" — the generic root, the
 *                    correct fallback for an unspecified class.
 *
 * Every code and display here was checked with the official HL7 FHIR
 * validator (validator_cli, R4) against tx.fhir.org's SNOMED CT International
 * edition: active concept, accepted display.
 *
 * An unknown / future enum value resolves to the generic `DISEASE_SNOMED`
 * root via the builder's fallback, never a guessed specific concept.
 */
export const ILLNESS_TYPE_SNOMED: Record<string, IllnessSnomedCategory> = {
  INFECTION: { code: "40733004", display: "Infectious disease" },
  ALLERGY: { code: "473011001", display: "Allergic condition" },
  INJURY: { code: "417163006", display: "Traumatic or non-traumatic injury" },
  MENTAL_HEALTH: { code: "74732009", display: "Mental disorder" },
  AUTOIMMUNE: { code: "85828009", display: "Autoimmune disease" },
  CHRONIC: { code: "27624003", display: "Chronic disease" },
  OTHER: { code: "64572001", display: "Disease" },
};
