/**
 * Practitioner (address-book) request/response validation.
 *
 * Source of truth for the `/api/practitioners*` wire contract; the OpenAPI
 * registry reuses these schemas. `userId` is NEVER a body field.
 *
 * `name` is the only required field, and it is plaintext rather than encrypted
 * so the picker can search and sort it in SQL — the same tradeoff the document
 * title makes, stated there too. `note` is the encrypted one.
 */
import { z } from "zod/v4";

export const practitionerCreateSchema = z
  .object({
    name: z.string().min(1).max(160),
    /** Free text, not an enum: practice signage does not fit a closed list. */
    specialty: z.string().max(120).nullable().optional(),
    practice: z.string().max(160).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    /** Becomes `noteEncrypted`. */
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type PractitionerCreate = z.infer<typeof practitionerCreateSchema>;

/**
 * Edit a practitioner. A body naming nothing is a 422, for the same reason as
 * the visit edit: a no-op that answers 200 hides a client defect.
 */
export const practitionerUpdateSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    specialty: z.string().max(120).nullable().optional(),
    practice: z.string().max(160).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "name at least one field to change",
  });

export type PractitionerUpdate = z.infer<typeof practitionerUpdateSchema>;

/** List query — a substring search over the plaintext name, bounded. */
export const practitionerListQuerySchema = z
  .object({
    q: z.string().min(1).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type PractitionerListQuery = z.infer<typeof practitionerListQuerySchema>;
