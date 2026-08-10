import { z } from "zod/v4";

/**
 * Emergency ("Notfalldaten") profile — the closed enum sets and the free-text
 * caps for the three encrypted columns.
 *
 * The three enums mirror the Prisma enums one-for-one (`EmergencyBloodType`,
 * `OrganDonorStatus`, `AdvanceDirectiveStatus`); the arrays are the single
 * source the form dropdowns and the Zod schemas both read, so a value cannot
 * exist on one side and not the other.
 */

export const EMERGENCY_BLOOD_TYPE_VALUES = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
  "UNKNOWN",
] as const;

export const ORGAN_DONOR_STATUS_VALUES = ["YES", "NO", "UNKNOWN"] as const;

export const ADVANCE_DIRECTIVE_STATUS_VALUES = [
  "EXISTS",
  "NONE",
  "UNKNOWN",
] as const;

export type EmergencyBloodTypeValue =
  (typeof EMERGENCY_BLOOD_TYPE_VALUES)[number];
export type OrganDonorStatusValue = (typeof ORGAN_DONOR_STATUS_VALUES)[number];
export type AdvanceDirectiveStatusValue =
  (typeof ADVANCE_DIRECTIVE_STATUS_VALUES)[number];

export const emergencyBloodTypeSchema = z.enum(EMERGENCY_BLOOD_TYPE_VALUES);
export const organDonorStatusSchema = z.enum(ORGAN_DONOR_STATUS_VALUES);
export const advanceDirectiveStatusSchema = z.enum(
  ADVANCE_DIRECTIVE_STATUS_VALUES,
);

/** Free-text length caps, applied BEFORE encryption. */
export const EMERGENCY_CONTACTS_MAX = 2000;
export const EMERGENCY_IMPLANTS_MAX = 1000;
export const EMERGENCY_NOTE_MAX = 2000;

/**
 * One free-text field: trims, treats an emptied field as a clear (`null`), and
 * caps the length. `null` clears the column; an omitted key leaves it untouched
 * (the route only writes keys the body carried).
 */
function freeText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();
}

/**
 * PATCH body. Every field is optional so a partial edit leaves the columns it
 * omits untouched; an explicit `null` clears that field. `.strict()` refuses an
 * unknown key rather than silently dropping it.
 */
export const emergencyProfileUpdateSchema = z
  .object({
    bloodType: emergencyBloodTypeSchema.nullable().optional(),
    organDonor: organDonorStatusSchema.nullable().optional(),
    advanceDirective: advanceDirectiveStatusSchema.nullable().optional(),
    contacts: freeText(EMERGENCY_CONTACTS_MAX).optional(),
    implants: freeText(EMERGENCY_IMPLANTS_MAX).optional(),
    note: freeText(EMERGENCY_NOTE_MAX).optional(),
  })
  .strict();

export type EmergencyProfileUpdate = z.infer<
  typeof emergencyProfileUpdateSchema
>;

/** The read shape the GET route returns and the form prefills from. */
export const emergencyProfileDtoSchema = z.object({
  bloodType: emergencyBloodTypeSchema.nullable(),
  organDonor: organDonorStatusSchema.nullable(),
  advanceDirective: advanceDirectiveStatusSchema.nullable(),
  contacts: z.string().nullable(),
  contactsUnreadable: z.boolean(),
  implants: z.string().nullable(),
  implantsUnreadable: z.boolean(),
  note: z.string().nullable(),
  noteUnreadable: z.boolean(),
});

export type EmergencyProfileDto = z.infer<typeof emergencyProfileDtoSchema>;
