/**
 * `GET /api/environment` — the environmental-context module overview.
 *
 * Returns the account's coarse home location, its travel overrides, a small
 * summary of stored daily observations (count + latest day), and the upstream
 * attribution string. Module-gated: a 403 `module.disabled` envelope when the
 * opt-in module is off. `userId` is narrowed from auth, never a body field.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { OPEN_METEO_ATTRIBUTION } from "@/lib/environment/open-meteo";
import { ENVIRONMENT_FETCH_QUEUE } from "@/lib/jobs/environment-fetch";
import { readQueueFailureForUser } from "@/lib/jobs/job-failures";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const [profile, travel, contextCount, latest, lastFetchFailure] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        select: {
          homeLat: true,
          homeLon: true,
          homeLabel: true,
          homeTimezone: true,
          homeSince: true,
          timezone: true,
        },
      }),
      prisma.environmentTravelLocation.findMany({
        where: { userId: user.id },
        orderBy: { startDate: "desc" },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          lat: true,
          lon: true,
          label: true,
        },
      }),
      prisma.environmentContext.count({ where: { userId: user.id } }),
      prisma.environmentContext.findFirst({
        where: { userId: user.id },
        orderBy: { date: "desc" },
        select: { date: true, fetchedAt: true },
      }),
      // A day count on its own cannot tell an empty module from a broken one —
      // which is exactly how a job that failed on every run since the module
      // shipped could render as "0 days recorded" and nothing else. The queue
      // knows; the overview asks it.
      readQueueFailureForUser(ENVIRONMENT_FETCH_QUEUE, user.id),
    ]);

  const home =
    profile?.homeLat != null && profile?.homeLon != null
      ? {
          lat: profile.homeLat,
          lon: profile.homeLon,
          label: profile.homeLabel,
          timezone: profile.homeTimezone ?? profile.timezone,
          // Effective-from instant: the settings surface uses it to label the
          // home and to prefill the backfill start (conservative default range).
          since: profile.homeSince?.toISOString() ?? null,
        }
      : null;

  annotate({
    action: { name: "environment.overview.read" },
    meta: {
      has_home: home !== null,
      travel_count: travel.length,
      context_days: contextCount,
      last_fetch_failed: lastFetchFailure !== null,
    },
  });

  return apiSuccess({
    home,
    travel,
    context: {
      days: contextCount,
      latestDate: latest?.date ?? null,
      latestFetchedAt: latest?.fetchedAt?.toISOString() ?? null,
    },
    // null = the last background runs did not fail (or there is no queue to
    // ask). Non-null names the failure so a zero day count is never left to
    // stand alone. No error text: that message is written for an operator.
    lastFetchFailure,
    attribution: OPEN_METEO_ATTRIBUTION,
  });
});
