import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  deleteManagedProfile,
  ManagedProfileLifecycleError,
} from "@/lib/managed-profiles/lifecycle";
import { annotate } from "@/lib/logging/context";

type RouteParams = { params: Promise<{ id: string }> };

/** Delete a managed record only after its cookie-backed Guardian proves MFA. */
export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const { id } = await params;

    try {
      await deleteManagedProfile({ profileId: id, guardianId: user.id });
    } catch (error) {
      if (error instanceof ManagedProfileLifecycleError) {
        return apiError("Managed profile not found", 404, {
          errorCode: "managed_profile.not_found",
        });
      }
      throw error;
    }

    annotate({
      action: { name: "managed_profile.delete" },
      meta: { profile_id: id },
    });
    return apiSuccess({ deleted: true });
  },
);
