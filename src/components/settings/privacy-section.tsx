"use client";

/**
 * v1.23 — "Data & Privacy" dashboard (P7).
 *
 * One coherent pane that ASSEMBLES already-shipped machinery — it does not
 * rebuild any of it. Each block either embeds an existing card (active
 * sessions, security activity, trusted devices) or links to the existing
 * surface that owns the action (export incl. the passphrase option, account
 * deletion / data reset, AI privacy mode, research mode). The retention +
 * encryption facts are read from the server so the copy stays truthful, and
 * the backup↔deletion lag is disclosed honestly.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Database,
  Download,
  Lock,
  ShieldCheck,
  Trash2,
  Clock,
  Sparkles,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { SecuritySessionsCard } from "@/components/settings/security-sessions-card";
import { SecurityActivityCard } from "@/components/settings/security-activity-card";
import { TrustedDevicesCard } from "@/components/settings/trusted-devices-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

interface PrivacySummary {
  retention: {
    coachMessagesDays: number;
    auditLogDays: number;
    deliveryLogDays: number;
  };
  encryption: {
    algorithm: string;
    columnCount: number;
    modelCount: number;
  };
}

export function PrivacySection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery({
    queryKey: queryKeys.privacySummary(),
    queryFn: () => apiGet<PrivacySummary>("/api/settings/privacy-summary"),
    enabled: isAuthenticated,
  });

  return (
    <div className="space-y-6">
      {/* Intro */}
      <SettingsInfoTile
        icon={Lock}
        tone="info"
        title={t("settings.privacy.intro.title")}
      >
        {t("settings.privacy.intro.body")}
      </SettingsInfoTile>

      {/* Encryption at rest */}
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("settings.privacy.encryption.title")}
          description={t("settings.privacy.encryption.description")}
        />
        <div className="space-y-3">
          <p className="text-sm">
            {summary
              ? t("settings.privacy.encryption.summary", {
                  algorithm: summary.encryption.algorithm,
                  columns: summary.encryption.columnCount,
                  models: summary.encryption.modelCount,
                })
              : t("settings.privacy.encryption.statement")}
          </p>
        </div>
      </SettingsCard>

      {/* What's stored */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Database}
          title={t("settings.privacy.stored.title")}
          description={t("settings.privacy.stored.description")}
        />
        <ul className="text-muted-foreground list-disc space-y-1 text-sm">
          <li>{t("settings.privacy.stored.measurements")}</li>
          <li>{t("settings.privacy.stored.medications")}</li>
          <li>{t("settings.privacy.stored.moodLabs")}</li>
          <li>{t("settings.privacy.stored.coach")}</li>
          <li>{t("settings.privacy.stored.integrations")}</li>
          <li>{t("settings.privacy.stored.security")}</li>
        </ul>
      </SettingsCard>

      {/* Retention */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Clock}
          title={t("settings.privacy.retention.title")}
          description={t("settings.privacy.retention.description")}
        />
        {summaryLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : summaryError || !summary ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.privacy.retention.unavailable")}
          </p>
        ) : (
          <ul className="text-muted-foreground space-y-1 text-sm">
            <li>
              {t("settings.privacy.retention.coach", {
                days: summary.retention.coachMessagesDays,
              })}
            </li>
            <li>
              {t("settings.privacy.retention.audit", {
                days: summary.retention.auditLogDays,
              })}
            </li>
            <li>
              {t("settings.privacy.retention.delivery", {
                days: summary.retention.deliveryLogDays,
              })}
            </li>
          </ul>
        )}
      </SettingsCard>

      {/* Export */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Download}
          title={t("settings.privacy.export.title")}
          description={t("settings.privacy.export.description")}
        />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/export">
              {t("settings.privacy.export.openExport")}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/gesundheitsakte">
              {t("settings.privacy.export.openHealthRecord")}
            </Link>
          </Button>
        </div>
      </SettingsCard>

      {/* Delete / reset — with the honest backup lag disclosure */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Trash2}
          title={t("settings.privacy.delete.title")}
          description={t("settings.privacy.delete.description")}
        />
        <div className="space-y-3">
          <SettingsInfoTile icon={Info} tone="warning">
            {t("settings.privacy.delete.backupLag")}
          </SettingsInfoTile>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/advanced">
              {t("settings.privacy.delete.openAdvanced")}
            </Link>
          </Button>
        </div>
      </SettingsCard>

      {/* Privacy posture (AI privacy mode + research mode live on their pages) */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Sparkles}
          title={t("settings.privacy.posture.title")}
          description={t("settings.privacy.posture.description")}
        />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/ai">
              {t("settings.privacy.posture.openAi")}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/advanced">
              {t("settings.privacy.posture.openResearch")}
            </Link>
          </Button>
        </div>
      </SettingsCard>

      {/* Active sessions + trusted devices + security activity (embedded) */}
      <SecuritySessionsCard isAuthenticated={isAuthenticated} />
      <TrustedDevicesCard isAuthenticated={isAuthenticated} />
      <SecurityActivityCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
