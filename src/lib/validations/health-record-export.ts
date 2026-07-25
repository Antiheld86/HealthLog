/**
 * v1.7.0 — health-record / doctor-handover export selection.
 *
 * Single strict Zod schema driving `POST /api/export/health-record`. The
 * flagship export route fails loudly on bad input (unlike the legacy
 * doctor-report route which tolerates drift) — `.strict()` rejects unknown
 * keys, and there is intentionally NO `userId` field (the user is always
 * narrowed from `requireAuth()`, never accepted from the body).
 *
 * The grouped `sections` shape is additive over the flat
 * `DoctorReportPrefs` used by the aggregator + PDF renderer. The
 * `toDoctorReportPrefs()` helper folds the grouped toggles down to the
 * flat shape the aggregator consumes, so PDF and FHIR describe identical
 * numbers (the source-of-truth property the two PDF endpoints share).
 */
import { z } from "zod/v4";
import { locales } from "@/lib/i18n/config";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  parseDoctorReportPrefs,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";

/** Grouped vital toggles. */
const vitalsGroupSchema = z
  .object({
    weight: z.boolean(),
    bp: z.boolean(),
    pulse: z.boolean(),
    oxygenSaturation: z.boolean(),
    bodyFat: z.boolean(),
    bodyComposition: z.boolean(),
  })
  .partial();

const cardioFitnessGroupSchema = z
  .object({
    restingHeartRate: z.boolean(),
    hrv: z.boolean(),
    vo2max: z.boolean(),
  })
  .partial();

const activityGroupSchema = z
  .object({
    steps: z.boolean(),
    distance: z.boolean(),
    sleep: z.boolean(),
  })
  .partial();

/**
 * `list` gates the medication list plus the per-dose administration
 * ledger; `compliance` gates the adherence figures and the GLP-1 therapy block.
 * The retired `glp1` / `sideEffects` / `activity.energy` keys were accepted and
 * discarded: no surface ever rendered them and no code read them. An unknown
 * key inside a group is stripped, so a caller still sending one is unaffected.
 */
const medicationsGroupSchema = z
  .object({
    list: z.boolean(),
    compliance: z.boolean(),
  })
  .partial();

/**
 * Grouped section toggles. Every group + key is optional so a partial
 * payload (the user flipped one checkbox) doesn't have to re-state the
 * whole tree. Missing keys resolve to the documented defaults.
 */
export const exportSectionsSchema = z
  .object({
    vitals: vitalsGroupSchema,
    cardioFitness: cardioFitnessGroupSchema,
    activity: activityGroupSchema,
    glucose: z.boolean(),
    medications: medicationsGroupSchema,
    mood: z.boolean(),
    bmi: z.boolean(),
    // Cycle / reproductive health — opt-in (privacy default OFF, like mood).
    cycle: z.boolean(),
    // Structured lab results — ON by default (recorded to share with a
    // clinician, same stance as BP / weight).
    labs: z.boolean(),
    // Structured allergy / intolerance records — ON by default (the
    // section every clinical intake asks for first; same stance as labs).
    allergies: z.boolean(),
    // Structured family history — ON by default, same stance as allergies.
    familyHistory: z.boolean(),
    // PHQ-9 / GAD-7 / WHO-5 / SCI screening totals. OFF unless the
    // caller sets it explicitly (`=== true`), like mood and cycle.
    mentalHealthScreeners: z.boolean(),
  })
  .partial();

export type ExportSections = z.infer<typeof exportSectionsSchema>;

/**
 * The top-level keys that exist ONLY in the grouped {@link exportSectionsSchema}
 * (never in the flat `doctorReportPrefsSchema`). Their presence is the reliable
 * signal that a persisted `sectionsJson` blob is the grouped shape rather than
 * the flat one — the flat shape carries `bp` / `weight` / `pulse` at the top
 * level, the grouped shape nests them under `vitals`.
 *
 * `glucose` is deliberately NOT a discriminator: it is a top-level boolean in
 * BOTH shapes (the flat `DoctorReportPrefs` gained its own `glucose` section
 * toggle), so its presence no longer distinguishes grouped from flat. A real
 * grouped export always carries one of the nested groups below, so detection
 * stays reliable without it — and a bare `{ glucose: false }` blob correctly
 * resolves through the flat parser.
 */
const GROUPED_SECTION_KEYS = [
  "vitals",
  "cardioFitness",
  "activity",
  "medications",
] as const;

/**
 * v1.28.17 — resolve a STORED `sectionsJson` blob (from a clinician share link
 * or any consumer that persists the export selection) to the flat
 * {@link DoctorReportPrefs} the aggregator + PDF renderer consume.
 *
 * The share-link create schema accepts the GROUPED {@link exportSectionsSchema}
 * and persists it raw, but the report aggregator speaks the FLAT shape. Reading
 * a grouped blob through the flat parser silently DROPS every grouped toggle
 * (`vitals.bp`, `activity.sleep`, `medications.compliance`) and falls back to
 * defaults-ON — so a section the owner switched OFF would still be served. This
 * resolver closes that gap: a grouped blob is folded through
 * {@link toDoctorReportPrefs}; a flat / empty / `{}` / null blob keeps the exact
 * legacy semantics via {@link parseDoctorReportPrefs}. Detection is by the
 * grouped-only keys, so it can never misread a flat blob as grouped (or vice
 * versa), and it needs no data migration — existing rows resolve correctly.
 */
export function resolveStoredReportSections(raw: unknown): DoctorReportPrefs {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const looksGrouped = GROUPED_SECTION_KEYS.some((k) => k in obj);
    if (looksGrouped) {
      const parsed = exportSectionsSchema.safeParse(obj);
      // A well-formed grouped blob folds down; a drifted one falls through to
      // the flat parser, which itself defaults on any shape it cannot read.
      if (parsed.success) return toDoctorReportPrefs(parsed.data);
    }
  }
  return parseDoctorReportPrefs(raw);
}

/**
 * Flagship export selection. `.strict()` so unknown keys (including any
 * attempt to smuggle a `userId`) 422 via `returnAllZodIssues`.
 */
export const exportSelectionSchema = z
  .object({
    format: z.enum(["pdf", "fhir", "package"]),
    range: z
      .object({
        startDate: z.iso.datetime({ offset: true }).optional(),
        endDate: z.iso.datetime({ offset: true }).optional(),
        days: z.number().int().min(1).max(365).optional(),
      })
      .strict()
      .optional(),
    sections: exportSectionsSchema.optional(),
    locale: z.enum(locales).optional(),
    practiceName: z.string().max(120).optional(),
    includeCharts: z.boolean().optional(),
    includeAiSummary: z.boolean().optional(),
    // FHIR only: additionally emit the German BfArM ATC URI alongside the WHO
    // entry on each medication concept (WHO stays first, byte-identical). When
    // omitted, the route derives it from a German-region locale.
    germanAtc: z.boolean().optional(),
  })
  .strict();

export type ExportSelection = z.infer<typeof exportSelectionSchema>;

/**
 * Fold the grouped selection down to the flat `DoctorReportPrefs` the
 * aggregator + PDF renderer consume. A group toggle that is `true` (or
 * absent, falling back to the section default) flips the matching flat
 * flag. Mood, cycle and the mental-health screeners stay privacy-default-OFF:
 * they only flip on when the caller set them explicitly.
 *
 * The fold used to read twelve of the twenty keys the schema
 * accepts and drop the rest on the floor, so a caller that switched off SpO₂,
 * body fat, body composition, resting heart rate, HRV, VO₂max, steps or
 * distance was silently overruled and the export panel rendered eight controls
 * that changed nothing. Every accepted key now resolves to a flat flag, and
 * `doctor-report-control-gating-guard.test.ts` fails the build if a control is
 * ever added back without one.
 */
export function toDoctorReportPrefs(
  sections: ExportSections | undefined,
): DoctorReportPrefs {
  const s = sections ?? {};
  const v = s.vitals ?? {};
  const c = s.cardioFitness ?? {};
  const a = s.activity ?? {};
  const m = s.medications ?? {};

  const fallback = DEFAULT_DOCTOR_REPORT_PREFS;
  return {
    weight: v.weight ?? fallback.weight,
    bp: v.bp ?? fallback.bp,
    pulse: v.pulse ?? fallback.pulse,
    bmi: s.bmi ?? fallback.bmi,
    // Mood is opt-in: only true when explicitly requested.
    mood: s.mood === true,
    medicationList: m.list ?? fallback.medicationList,
    // A caller that sends only `medications.list = false` means "no medication
    // data" — the single panel control has always driven both keys together, so
    // the list value keeps standing in for a missing compliance value.
    compliance: m.compliance ?? m.list ?? fallback.compliance,
    sleep: a.sleep ?? fallback.sleep,
    glucose: s.glucose ?? fallback.glucose,
    // Cycle is opt-in: only true when explicitly requested (privacy).
    cycle: s.cycle === true,
    labs: s.labs ?? fallback.labs,
    allergies: s.allergies ?? fallback.allergies,
    familyHistory: s.familyHistory ?? fallback.familyHistory,
    oxygenSaturation: v.oxygenSaturation ?? fallback.oxygenSaturation,
    bodyFat: v.bodyFat ?? fallback.bodyFat,
    bodyComposition: v.bodyComposition ?? fallback.bodyComposition,
    restingHeartRate: c.restingHeartRate ?? fallback.restingHeartRate,
    hrv: c.hrv ?? fallback.hrv,
    vo2max: c.vo2max ?? fallback.vo2max,
    steps: a.steps ?? fallback.steps,
    distance: a.distance ?? fallback.distance,
    // Screening totals are opt-in: only true when explicitly requested.
    mentalHealthScreeners: s.mentalHealthScreeners === true,
  };
}
