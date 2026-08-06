import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  LastManagedGuardianError,
  ManagedProfileLifecycleError,
} from "@/lib/managed-profiles/lifecycle";
import { revokeManagedProfileGuardian } from "@/lib/sharing/grants";
import { annotate } from "@/lib/logging/context";

type RouteParams = { params: Promise<{ id: string; grantId: string }> };

/** End another Guardian's access from a freshly verified browser session. */
export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const { id, grantId } = await params;

    try {
      const grant = await revokeManagedProfileGuardian({
        profileId: id,
        guardianId: user.id,
        grantId,
      });
      annotate({
        action: { name: "managed_profile.guardian.revoked" },
        meta: { profile_id: id, grant_id: grant.id },
      });
      return apiSuccess(grant);
    } catch (error) {
      if (error instanceof LastManagedGuardianError) {
        return apiError("Add another Guardian before ending this access", 409, {
          errorCode: "managed_profile.guardian.required",
        });
      }
      if (error instanceof ManagedProfileLifecycleError) {
        return apiError("Managed profile or Guardian not found", 404, {
          errorCode: "managed_profile.not_found",
        });
      }
      throw error;
    }
  },
);
