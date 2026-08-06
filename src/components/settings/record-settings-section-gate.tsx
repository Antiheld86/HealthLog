"use client";

import type { ReactNode } from "react";
import { CircleSlash } from "lucide-react";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { classifySettingsDestination } from "@/lib/record-settings";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ManagedIntegrationStatus } from "@/components/settings/managed-integration-status";
import { SettingsCard } from "@/components/settings/settings-card";
import type { SettingsSectionSlug } from "@/components/settings/section-slugs";

/**
 * Stops actor-scoped Settings components from mounting while the browser is
 * switched into another record. The only managed integration surface is its
 * status projection; all other direct links resolve to a local refusal state.
 */
export function RecordSettingsSectionGate({
  section,
  children,
}: {
  section: SettingsSectionSlug;
  children: ReactNode;
}) {
  const { inSharedRecord, recordKind } = useRecordCapabilities();
  const { t } = useTranslations();

  if (!inSharedRecord) return children;

  const destination = classifySettingsDestination(section);
  if (
    recordKind === "managed" &&
    destination.kind === "managed-guardian" &&
    section === "integrations"
  ) {
    return <ManagedIntegrationStatus />;
  }

  return (
    <SettingsCard aria-labelledby="shared-record-settings-unavailable-title">
      <SettingsCardHeader
        icon={CircleSlash}
        title={t("settings.sharedRecord.unavailableTitle")}
        titleId="shared-record-settings-unavailable-title"
        description={t("settings.sharedRecord.unavailableDescription")}
      />
    </SettingsCard>
  );
}
