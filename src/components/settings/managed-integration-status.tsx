"use client";

import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import { SettingsCard } from "@/components/settings/settings-card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { apiGet } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { assertRecordSettingsResponseForRecord } from "@/lib/record-settings";

type ManagedIntegrationState =
  "connected" | "error_transient" | "error_reauth" | "disconnected" | "parked";

interface ManagedIntegrationStatusResponse {
  recordId: string;
  integrations: Array<{
    integration: keyof typeof INTEGRATION_DISPLAY_NAMES;
    state: ManagedIntegrationState;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
  }>;
}

const INTEGRATION_DISPLAY_NAMES = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  nightscout: "Nightscout",
  polar: "Polar",
  oura: "Oura",
  "google-health": "Google Health",
  strava: "Strava",
} as const;

function recordStatusPillState(state: ManagedIntegrationState) {
  switch (state) {
    case "connected":
      return "connected" as const;
    case "error_transient":
      return "warning" as const;
    case "error_reauth":
      return "error" as const;
    case "parked":
      return "parked" as const;
    case "disconnected":
      return "disconnected" as const;
  }
}

/**
 * The managed-record integration view is deliberately a status projection.
 * It reads the active record's id from the resolved account-access payload and
 * has no connection, credential, sync, or provider-control affordance.
 */
export function ManagedIntegrationStatus() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const activeRecord = user?.accountAccess?.active ?? null;
  const recordId = activeRecord?.accountId ?? null;
  const statusQuery = useQuery({
    queryKey: queryKeys.recordSettingsIntegrations(recordId ?? ""),
    queryFn: async () => {
      const response = await apiGet<ManagedIntegrationStatusResponse>(
        "/api/record-settings/integrations",
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      return response;
    },
    enabled: activeRecord?.recordKind === "managed" && recordId !== null,
  });

  if (statusQuery.isError) {
    return <QueryErrorCard onRetry={() => void statusQuery.refetch()} />;
  }

  if (statusQuery.isLoading || !statusQuery.data) {
    return (
      <SettingsCard aria-busy="true" aria-live="polite">
        <SettingsCardHeader
          icon={Plug}
          title={t("settings.sections.integrations.title")}
          description={t("settings.sharedRecord.integrationStatusDescription")}
        />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard aria-labelledby="managed-integration-status-title">
      <SettingsCardHeader
        icon={Plug}
        title={t("settings.sections.integrations.title")}
        titleId="managed-integration-status-title"
        description={t("settings.sharedRecord.integrationStatusDescription")}
      />
      <ul
        className="mt-4 space-y-3"
        aria-label={activeRecord?.displayName ?? undefined}
      >
        {statusQuery.data.integrations.map((integration) => (
          <li
            key={integration.integration}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm font-medium">
              {INTEGRATION_DISPLAY_NAMES[integration.integration]}
            </span>
            <IntegrationStatusPill
              state={recordStatusPillState(integration.state)}
              lastSyncAt={
                integration.lastSuccessAt ?? integration.lastAttemptAt
              }
              testId={`managed-integration-${integration.integration}`}
            />
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
