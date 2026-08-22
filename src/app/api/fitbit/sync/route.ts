import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { readSyncTriggerBody } from "@/lib/integrations/sync-request";
import { syncUserFitbit } from "@/lib/fitbit/sync";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Fitbit sync for the current user.
 *
 * Mirrors the WHOOP manual-sync route: incremental by default, full history when
 * `{ fullSync: true }` is posted.
 *
 * Rate-limited: every sibling Fitbit route (connect / test / resume) is limited;
 * this one was the outlier, while `{ fullSync: true }` drives four resource syncs
 * over the classic Web API's tight 150 req/h-per-user budget. A tight loop or a
 * stolen native token could exhaust that budget and pin Prisma. A baseline 5/60s
 * bucket (matching the test route) gates the route, and the expensive `fullSync`
 * path carries a tighter 1/hour bucket of its own.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.sync" } });

  const rl = await checkRateLimit(`fitbit-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const body = await readSyncTriggerBody(request);
  if (body.error) return body.error;
  const { fullSync } = body;

  // The full-history walk is the expensive path (four paginated resource
  // walkers); cap it well below the incremental bucket so a re-trigger loop
  // cannot churn the Google quota.
  if (fullSync) {
    const fullRl = await checkRateLimit(
      `fitbit-sync-full:${user.id}`,
      1,
      60 * 60_000,
    );
    if (!fullRl.allowed) {
      return apiError("Full sync is limited to once per hour", 429, {
        errorCode: "rate_limited_self",
      });
    }
  }

  // The verdict is resolved here, not in the card: a run that imported nothing
  // because every resource failed is not the same answer as a quiet hour, and
  // both used to render as a green tick with a count.
  const result = await syncUserFitbit(user.id, { fullSync });
  return apiSuccess({ ...resolveSyncOutcome(result), fullSync });
});
