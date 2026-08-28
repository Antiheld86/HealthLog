/**
 * v1.37.0 — the two bodies the managed-profile family accepts.
 *
 * Here rather than beside each route because the OpenAPI table publishes them,
 * and a schema written twice is a contract that drifts on the third change.
 * The route modules import these; nothing imports the route modules.
 *
 * Both are `.strict()`. A managed profile is a person's health record created
 * by somebody else, so a field the sender did not mean to send is refused
 * rather than ignored — and the client types name exactly these fields for the
 * same reason (`src/lib/queries/use-managed-profiles.ts`).
 */
import { z } from "zod/v4";

import { isValidTimezone } from "@/lib/tz/format";

/** The body `POST /api/managed-profiles` accepts. */
export const createManagedProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    dateOfBirth: z.iso.date().nullable().optional(),
    locale: z.enum(["de", "en", "es", "fr", "it", "pl", "ko"]),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimezone, "Invalid IANA timezone"),
  })
  .strict();

/** The body `POST /api/managed-profiles/{id}/guardians` accepts. */
export const inviteManagedProfileGuardianSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
