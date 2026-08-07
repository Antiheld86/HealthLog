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
      // Two fields, not the grant row this used to hand back whole. What ended
      // and when is the entire answer; the party who held it is already on the
      // roster the caller is about to re-read, and `grantorId`, `granteeId` and
      // `scopeJson` are a table's columns rather than a contract.
      const { revokedAt } = grant;
      if (!revokedAt) {
        // The service stamps it inside the transaction it returns from, so
        // this cannot happen — and if it ever does, an invented timestamp
        // would be worse than the operator hearing about it.
        throw new Error("A revoked Guardian grant carries no revocation time");
      }
      return apiSuccess({
        grantId: grant.id,
        revokedAt: revokedAt.toISOString(),
      });
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
