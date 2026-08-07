"use client";

/**
 * The catch-all row — no envelope entry renders nowhere.
 *
 * A provider whose Settings card was removed kept its sync cron, its ledger
 * row and its block on the status envelope, and lost the only surface that
 * could have shown it dying. It then stopped syncing for a month and nothing,
 * anywhere, said so.
 *
 * This row closes the class rather than the instance: the connections panel
 * iterates the envelope and renders this for every configured entry no bespoke
 * card claims. Adding a provider to the envelope without a card now produces a
 * visible row instead of a silent JSON block, and a structural test pins that
 * nothing can go unrendered.
 *
 * Read-only by design. A deliberately dropped integration does not get its
 * management surface back; it gets an honest status.
 */

import { Plug } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  formatRelative,
  IntegrationStatusPill,
} from "@/components/settings/integration-status-pill";
import { useTranslations } from "@/lib/i18n/context";

import {
  pillFailurePropsFor,
  pillStateFor,
  pillTimestampFor,
  type IntegrationKey,
  type IntegrationStatusViewModel,
} from "./shared";

/**
 * Display names, mirroring the server-side `INTEGRATION_LABELS`. Only the
 * card-less keys can ever reach this row, but the map stays complete so a
 * future drop needs no edit here.
 */
export const INTEGRATION_DISPLAY_NAMES: Record<IntegrationKey, string> = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  nightscout: "Nightscout",
  polar: "Polar",
  oura: "Oura",
  "google-health": "Google Health",
  strava: "Strava",
};

export function IntegrationFallbackRow({
  status,
  now,
}: {
  status: IntegrationStatusViewModel;
  /** Override "now" for deterministic testing. */
  now?: Date;
}) {
  const { t } = useTranslations();

  const pillState = pillStateFor(status);
  const reference = now ?? new Date();
  const lastAttemptAt =
    status.lastAttemptAt ?? status.syncHealth?.since ?? null;
  const meta = lastAttemptAt
    ? t("settings.integrationFallback.lastAttempt", {
        relative: formatRelative(
          Math.max(0, reference.getTime() - new Date(lastAttemptAt).getTime()),
          t,
        ),
      })
    : t("settings.integrationFallback.noAttempt");

  return (
    <SettingsCard
      data-testid="integration-fallback-row"
      data-integration={status.integration}
    >
      <SettingsCardHeader
        icon={Plug}
        title={
          INTEGRATION_DISPLAY_NAMES[status.integration] ?? status.integration
        }
        description={t("settings.integrationFallback.description")}
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={pillTimestampFor(status)}
            {...pillFailurePropsFor(status)}
            now={now}
          />
        }
      />
      <p className="text-muted-foreground text-xs">{meta}</p>
    </SettingsCard>
  );
}
