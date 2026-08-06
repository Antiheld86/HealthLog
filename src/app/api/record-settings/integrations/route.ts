import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  getIntegrationStatus,
  type IntegrationKey,
} from "@/lib/integrations/status";
import { annotate } from "@/lib/logging/context";
import { resolveGuardianRecordSettingsAccess } from "@/lib/record-settings";

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
  const integrations = await Promise.all(
    MANAGED_INTEGRATIONS.map(async (integration) => {
      const status = await getIntegrationStatus(access.recordId, integration);
      return {
        integration: status.integration,
        state: status.state,
        lastSuccessAt: status.lastSuccessAt,
        lastAttemptAt: status.lastAttemptAt,
      };
    }),
  );

  annotate({ action: { name: "record-settings.integrations.get" } });

  return apiSuccess({ recordId: access.recordId, integrations });
});
