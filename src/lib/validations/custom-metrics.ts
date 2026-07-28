/**
 * v1.25.5 — user-defined custom-metric validation.
 *
 * A `CustomMetric` defines an arbitrary measurement ONCE: free-text name + unit,
 * an optional target window, optional display decimals, and an optional
 * description. Logging a value later just picks the metric — the unit is
 * snapshotted onto the entry server-side at write time.
 *
 * Deliberately a SEPARATE generic store from the closed `MeasurementType`
 * system (mirrors the Biomarker catalog ↔ LabResult split): not synced, not in
 * FHIR, not in AI insights — log + chart only. All fields are plaintext.
 *
 * The optional target window is the user's own "good range" and is charted as a
 * reference band; both bounds are independently optional and, when both are
 * present, the low bound must not exceed the high bound.
 */
import { z } from "zod/v4";

import { validateEntryInstant } from "@/lib/validations/entry-instant";

/** Trimmed, bounded free-text field with a min-length guard. */
const requiredText = (max: number) => z.string().trim().min(1).max(max);

const targetLow = z.number().finite().optional();
const targetHigh = z.number().finite().optional();

/** Optional display decimals, capped at a sane precision. */
const decimals = z.number().int().min(0).max(6).optional();

const optionalDescription = z
  .string()
  .trim()
  .max(2000)
  .optional()
  // An empty / whitespace-only description normalises to "none" so a blank
  // field clears rather than stores an empty string.
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const createCustomMetricSchema = z
  .object({
    name: requiredText(120),
    unit: requiredText(40),
    targetLow,
    targetHigh,
    decimals,
    description: optionalDescription,
    correlationEnabled: z.boolean().default(false),
  })
  .refine(
    (d) =>
      d.targetLow === undefined ||
      d.targetHigh === undefined ||
      d.targetLow <= d.targetHigh,
    {
      message: "targetLow must not exceed targetHigh",
      path: ["targetLow"],
    },
  );

export type CreateCustomMetricInput = z.infer<typeof createCustomMetricSchema>;

/**
 * Update schema: every field optional (partial edit). `targetLow` /
 * `targetHigh` / `decimals` / `description` accept an explicit `null` to clear
 * the stored value — distinct from an omitted key, which leaves it untouched.
 */
export const updateCustomMetricSchema = z
  .object({
    name: requiredText(120).optional(),
    unit: requiredText(40).optional(),
    targetLow: targetLow.or(z.null()),
    targetHigh: targetHigh.or(z.null()),
    decimals: decimals.or(z.null()),
    description: optionalDescription.or(z.null()),
    correlationEnabled: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.targetLow === undefined ||
      d.targetLow === null ||
      d.targetHigh === undefined ||
      d.targetHigh === null ||
      d.targetLow <= d.targetHigh,
    {
      message: "targetLow must not exceed targetHigh",
      path: ["targetLow"],
    },
  );

export type UpdateCustomMetricInput = z.infer<typeof updateCustomMetricSchema>;

/**
 * Far-past floor for a custom-metric entry. A self-hoster legitimately
 * backdates an old log, so the window is generous (50 years) but still rejects
 * epoch-zero / corrupted instants via the shared 1900 floor.
 */
const ENTRY_MAX_AGE_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;

/** Shared `measuredAt` field: ISO string → Date, plausibility-bounded. */
const measuredAtField = validateEntryInstant(
  z
    .string()
    .datetime({ message: "measuredAt must be an ISO 8601 datetime" })
    .transform((s) => new Date(s)),
  {
    maxAgeMs: ENTRY_MAX_AGE_MS,
    pastMessage: "Measurement date is too far in the past",
  },
);

const optionalNote = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const createCustomMetricEntrySchema = z.object({
  value: z.number().finite(),
  measuredAt: measuredAtField,
  note: optionalNote,
});

export type CreateCustomMetricEntryInput = z.infer<
  typeof createCustomMetricEntrySchema
>;

/** Update an entry: value / measuredAt / note partial edit. */
export const updateCustomMetricEntrySchema = z.object({
  value: z.number().finite().optional(),
  measuredAt: measuredAtField.optional(),
  note: optionalNote.or(z.null()),
});

export type UpdateCustomMetricEntryInput = z.infer<
  typeof updateCustomMetricEntrySchema
>;

/** List query for the entry feed: offset pagination + sort direction. */
export const listCustomMetricEntriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListCustomMetricEntriesInput = z.infer<
  typeof listCustomMetricEntriesSchema
>;
