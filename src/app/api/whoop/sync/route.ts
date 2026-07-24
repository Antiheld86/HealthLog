import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { syncUserWhoop } from "@/lib/whoop/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a WHOOP sync for the current user (v1.11.0).
 *
 * Mirrors the Withings manual-sync route: incremental by default, full
 * history when `{ fullSync: true }` is posted.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.sync" } });

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

  const { imported } = await syncUserWhoop(user.id, { fullSync });
  return apiSuccess({ imported, fullSync });
});
