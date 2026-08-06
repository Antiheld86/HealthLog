import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  getIntegrationStatus,
  type IntegrationKey,
} from "@/lib/integrations/status";
import { annotate } from "@/lib/logging/context";
import {
  resolveGuardianRecordSettingsAccess,
  resolveManagedIntegrationState,
} from "@/lib/record-settings";

export const dynamic = "force-dynamic";

const MANAGED_INTEGRATIONS: readonly IntegrationKey[] = [
  "withings",
  "whoop",
  "fitbit",
  "nightscout",
  "polar",
  "oura",
  "google-health",
  "strava",
];

/**
 * A managed profile may disclose whether its existing integrations are
 * connected, but this endpoint deliberately has no control or credential
 * projection. OAuth and provider state cannot safely carry a record selector.
 */
export const GET = apiHandler(async () => {
  const context = await requireGuardianAuth();
  const access = resolveGuardianRecordSettingsAccess(context);
  if (!access) throw new SharingAccessDeniedError();
  const [statuses, withings, whoop, fitbit, googleHealth] = await Promise.all([
    Promise.all(
      MANAGED_INTEGRATIONS.map((integration) =>
        getIntegrationStatus(access.recordId, integration),
      ),
    ),
    prisma.withingsConnection.findUnique({
      where: { userId: access.recordId },
      select: { id: true },
    }),
    prisma.whoopConnection.findUnique({
      where: { userId: access.recordId },
      select: { whoopUserId: true },
    }),
    prisma.fitbitConnection.findUnique({
      where: { userId: access.recordId },
      select: { id: true },
    }),
    prisma.googleHealthConnection.findUnique({
      where: { userId: access.recordId },
      select: { id: true },
    }),
  ]);
  const connected: Record<IntegrationKey, boolean> = {
    withings: withings !== null,
    whoop: whoop?.whoopUserId != null,
    fitbit: fitbit !== null,
    "google-health": googleHealth !== null,
    nightscout: context.user.nightscoutUrlEncrypted !== null,
    polar: context.user.polarAccessTokenEncrypted !== null,
    oura: context.user.ouraAccessTokenEncrypted !== null,
    strava: context.user.stravaAccessTokenEncrypted !== null,
  };
  const integrations = statuses.map((status) => ({
    integration: status.integration,
    state: resolveManagedIntegrationState(
      status.state,
      connected,
      status.integration,
    ),
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
  }));

  annotate({ action: { name: "record-settings.integrations.get" } });

  return apiSuccess({ recordId: access.recordId, integrations });
});
