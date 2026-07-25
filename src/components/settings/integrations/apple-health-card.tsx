"use client";

/**
 * Apple Health — the one integration with no ledger row and no cron.
 *
 * The iOS app pushes; nothing here polls. The card used to derive its status
 * from the mere presence of `lastSyncedAt`, so any timestamp at all painted the
 * green "data received" chip — a pipe dead for three weeks looked exactly like
 * one that delivered this morning. It now reads the server's verdict, which
 * applies a seven-day threshold to the same timestamp, and renders the shared
 * pill instead of a bespoke badge so the flagship integration speaks the same
 * status language as its siblings.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, Upload } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import type {
  MetricFreshnessEntry,
  SyncHealth,
} from "@/lib/integrations/sync-verdict";
import { queryKeys } from "@/lib/query-keys";

import { MetricFreshnessDisclosure } from "./metric-freshness-disclosure";
import { IntegrationErrorMessage, pillStateForVerdict } from "./shared";

interface HealthKitStatus {
  lastSyncedAt: string | null;
  syncHealth?: SyncHealth;
  metricFreshness?: MetricFreshnessEntry[];
}

export function AppleHealthCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const {
    data: status,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.healthKitStatus(),
    queryFn: () => apiGet<HealthKitStatus>("/api/integrations/healthkit"),
    enabled,
    refetchOnWindowFocus: true,
  });

  const verdict = status?.syncHealth?.verdict;
  const pillState = pillStateForVerdict(verdict);
  // A failed status read is an error line, not a status state — the card says
  // nothing about the pipe it could not ask about.
  const showPill = !isLoading && !isError && !!status;

  return (
    <SettingsCard
      as="section"
      aria-labelledby="apple-health-card-title"
      data-testid="apple-health-card"
    >
      <SettingsCardHeader
        icon={HeartPulse}
        titleId="apple-health-card-title"
        title={t("settings.appleHealth.title")}
        description={t("settings.appleHealth.description")}
        status={
          showPill ? (
            <IntegrationStatusPill
              testId="apple-health-status"
              state={pillState}
              lastSyncAt={status?.lastSyncedAt ?? null}
            />
          ) : null
        }
      />

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4 pl-7">
        {isError && (
          <IntegrationErrorMessage
            message={t("settings.appleHealth.status.unavailable")}
          />
        )}

        {verdict === "stale" && (
          <p className="text-warning text-sm" data-testid="apple-health-stale">
            {t("settings.appleHealth.staleNote")}
          </p>
        )}

        <MetricFreshnessDisclosure
          entries={status?.metricFreshness}
          idPrefix="apple-health"
        />

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {t("settings.appleHealth.setupTitle")}
          </h3>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>{t("settings.appleHealth.permissionStep")}</li>
            <li>{t("settings.appleHealth.backgroundStep")}</li>
          </ol>
        </div>

        <div className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs sm:max-w-xl">
            {t("settings.appleHealth.importNote")}
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
          >
            <Link
              href="/settings/export#settings-section-import-title"
              data-testid="apple-health-import-link"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {t("settings.appleHealth.importAction")}
            </Link>
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
