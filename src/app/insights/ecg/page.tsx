"use client";

import Link from "next/link";
import { Activity } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { Button } from "@/components/ui/button";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { EcgSection } from "@/components/insights/ecg-section";

/**
 * v1.30 — `/insights/ecg` (UX/IA audit finding H1).
 *
 * Routed home for the ECG recording surface. Before this page the only
 * inbound pointer to a user's ECGs was a cross-link card on the spot-pulse
 * page; hiding the overview ECG teaser in "Anpassen" left no route back at
 * all. This page gives ECG its own address, reached from the Heart-group
 * pill in the tab strip (gated on `hasRecordings`) and the metric catalog.
 *
 * The surface itself is the existing `<EcgSection>`, reused verbatim — its
 * non-diagnostic disclaimer + waveform logic are load-bearing and untouched.
 * We only suppress its internal `<SectionHeading>` (via `hideHeading`) because
 * `<SubPageShell>` already renders the page heading, mirroring how every other
 * routed sub-page lets the shell own the `<h1>`.
 *
 * The overview `<EcgSection>` teaser on `/insights` stays as-is.
 */
export default function InsightsEcgPage() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  // Reuse the SAME query cell `<EcgSection>` reads (`insightsEcgList`) so the
  // page and the section share one cache entry. The page only needs the
  // `hasRecordings` flag to choose between the empty state and the section.
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.insightsEcgList(),
    queryFn: () => apiGet<{ hasRecordings: boolean }>("/api/insights/ecg"),
    enabled: isAuthenticated,
  });

  // Data-availability empty state — a direct URL hit (or deleted recordings)
  // lands here without a section to show. Mirrors the sub-page convention:
  // a calm one-line scaffold + a connect-a-device CTA, never a blank surface.
  // While the probe is in flight we render nothing extra (the section self-
  // gates too), so first paint stays quiet rather than flashing an empty card.
  if (!isLoading && data && !data.hasRecordings) {
    return (
      <SubPageShell
        title={t("insights.ecg.sectionTitle")}
        description={t("insights.subPage.ecgDescription")}
      >
        <MetricEmptyState
          icon={<Activity className="size-6" />}
          title={t("insights.ecg.emptyTitle")}
          description={t("insights.ecg.emptyDescription")}
          cta={
            <Button size="sm" asChild>
              <Link href="/settings/integrations">
                {t("insights.ecg.emptyCta")}
              </Link>
            </Button>
          }
          coachPrefill={null}
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.ecg.sectionTitle")}
      description={t("insights.subPage.ecgDescription")}
    >
      {/* What the app does and does not claim about a trace. Its own
          paragraph, so the page explainer above stays one sentence. */}
      <p className="text-muted-foreground text-sm">
        {t("insights.subPage.ecgDisclaimer")}
      </p>
      <EcgSection enabled={isAuthenticated} hideHeading />
    </SubPageShell>
  );
}
