import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { annotate } from "@/lib/logging/context";
import { isValidTimezone } from "@/lib/tz/format";

const managedProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    dateOfBirth: z.iso.date().nullable().optional(),
    locale: z.enum(["de", "en", "es", "fr", "it", "pl"]),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimezone, "Invalid IANA timezone"),
  })
  .strict();

/**
 * Create a record a Guardian administers. This deliberately uses the
 * cookie-only fresh-MFA gate: a Bearer token cannot mint a credential-less
 * person and persistent management relationship.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = managedProfileSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: user.id,
    displayName: parsed.data.displayName,
    dateOfBirth: parsed.data.dateOfBirth
      ? new Date(`${parsed.data.dateOfBirth}T00:00:00.000Z`)
      : null,
    locale: parsed.data.locale,
    timezone: parsed.data.timezone,
  });

  await auditLog("managed_profile.created", {
    userId: user.id,
    details: { profileId: profile.id, grantId: creatorGrant.id },
  }).catch(() => {});
  annotate({
    action: { name: "managed_profile.create" },
    meta: { profile_id: profile.id },
  });

  return apiSuccess(
    {
      id: profile.id,
      displayName: profile.displayName,
      dateOfBirth: profile.dateOfBirth,
      locale: profile.locale,
      timezone: profile.timezone,
      recordKind: "managed" as const,
    },
    201,
  );
});
