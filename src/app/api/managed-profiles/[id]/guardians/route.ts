import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireFreshMfa,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { ManagedProfileLifecycleError } from "@/lib/managed-profiles/lifecycle";
import { checkRateLimit } from "@/lib/rate-limit";
import { GrantError, inviteManagedProfileGuardian } from "@/lib/sharing/grants";

type RouteParams = { params: Promise<{ id: string }> };

const INVITE_LIMIT = 10;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

const guardianInviteSchema = z
  .object({ identifier: z.string().trim().min(1).max(320) })
  .strict();

/** Invite another Guardian from a cookie-backed, freshly verified session. */
export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const rateLimit = await checkRateLimit(
      `managed-profile:guardian-invite:${user.id}`,
      INVITE_LIMIT,
      INVITE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      return apiError("Too many invitations, try again later", 429);
    }
    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 8 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = guardianInviteSchema.safeParse(body);
    if (!parsed.success) return returnAllZodIssues(parsed.error, 422);
    const { id } = await params;

    const invitee = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: parsed.data.identifier, mode: "insensitive" } },
          { email: { equals: parsed.data.identifier, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (!invitee) return apiError("No account with that name or e-mail", 404);

    try {
      const grant = await inviteManagedProfileGuardian({
        profileId: id,
        guardianId: user.id,
        granteeId: invitee.id,
      });
      annotate({
        action: { name: "managed_profile.guardian.invited" },
        meta: { profile_id: id, grant_id: grant.id },
      });
      return apiSuccess(grant, 201);
    } catch (error) {
      if (error instanceof GrantError && error.code === "self_grant") {
        return apiError("An account cannot be shared with itself", 422, {
          errorCode: "managed_profile.guardian.self",
        });
      }
      if (error instanceof GrantError) {
        return apiError("That account already has access", 409, {
          errorCode: "managed_profile.guardian.duplicate",
        });
      }
      if (error instanceof ManagedProfileLifecycleError) {
        return apiError("Managed profile not found", 404, {
          errorCode: "managed_profile.not_found",
        });
      }
      throw error;
    }
  },
);
