import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireCookieAuth,
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
import { listManagedProfileGuardians } from "@/lib/managed-profiles/guardian-list";
import { ManagedProfileLifecycleError } from "@/lib/managed-profiles/lifecycle";
import { checkRateLimit } from "@/lib/rate-limit";
import { GrantError, inviteManagedProfileGuardian } from "@/lib/sharing/grants";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Who looks after this profile.
 *
 * The read the panel needs before it can offer to remove anybody, and the one
 * the last-Guardian floor is counted from before the click rather than
 * discovered as a 409 after it.
 *
 * Cookie-only, like every endpoint in this family, and for the same structural
 * reason: `requireCookieAuth` reads only the session cookie and never falls
 * through to the Bearer branch. (Named that way rather than by the session
 * helper it calls, because `session-surface-guard.test.ts` matches on the
 * helper's NAME in file text and a comment naming it enrols this route in a
 * list of files that resolve a session themselves. This one does not.)
 * Fresh MFA is deliberately NOT required — this
 * is a read, and it discloses nothing the caller cannot already read on their
 * own sharing panel about a party to a grant they hold. The gate belongs to the
 * acts, not to looking.
 *
 * An actor surface: the profile is named by the URL, and the caller acts as
 * themselves. `requireRecordAuth` / `requireGuardianAuth` would make the roster
 * answerable only while switched INTO the profile, which is backwards for a
 * panel whose whole purpose is to work from the Guardian's own account.
 */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const guardians = await listManagedProfileGuardians({
      profileId: id,
      callerId: user.id,
    });
    // One refusal for "no such account", "not a managed profile" and "you are
    // not a Guardian of it", so the route is not an enumeration oracle.
    if (guardians === null) {
      return apiError("Managed profile not found", 404, {
        errorCode: "managed_profile.not_found",
      });
    }

    annotate({
      action: { name: "managed_profile.guardian.list" },
      meta: { profile_id: id, guardian_count: guardians.length },
    });
    return apiSuccess(guardians);
  },
);

const INVITE_LIMIT = 10;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

const guardianInviteSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
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
        expiresAt: parsed.data.expiresAt
          ? new Date(parsed.data.expiresAt)
          : null,
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
        if (error.code === "managed_grantee") {
          return apiError("A managed profile cannot be a Guardian", 422, {
            errorCode: "managed_profile.guardian.managed_invitee",
          });
        }
        return apiError("Managed profile not found", 404, {
          errorCode: "managed_profile.not_found",
        });
      }
      throw error;
    }
  },
);
