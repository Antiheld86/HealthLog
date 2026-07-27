import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Withings sync for the current user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.sync" } });

  let fullSync = false;
  try {
    const raw = await request.text();
    // Flag-only payload — cap the parse cost (mirrors safeJson maxBytes).
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    fullSync = body?.fullSync === true;
  } catch {
    // no body provided -> default incremental sync
  }

  const result = await syncUserMeasurements(user.id, { fullSync });
  return apiSuccess({ ...resolveSyncOutcome(result), fullSync });
});
