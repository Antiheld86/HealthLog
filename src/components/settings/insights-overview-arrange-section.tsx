"use client";

import { useMemo } from "react";

import { LayoutGrid, Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import { InsightsEditMode } from "@/components/insights/insights-edit-mode";
import { SectionHeading } from "@/components/ui/section-heading";
import { SettingsCard } from "@/components/settings/settings-card";
import { type InsightsSectionId } from "@/lib/insights-layout";

/**
 * v1.15.18 — overview-arrange block for the Insights settings section.
 *
 * Embeds the existing v1.15.11 `<InsightsEditMode>` (section show/hide + order,
 * persisted to `insightsLayoutJson.sections`) as an always-open surface. There
 * is no "Anpassen" toggle here — Settings IS the customise surface — so `onClose`
 * is a no-op (after a "Fertig" save the layout query has already settled into the
 * shared cache; the editor simply stays mounted).
 *
 * `gatedOffSectionIds` mirrors the mother page's gate logic so a section whose
 * feature flag / data gate is off renders its row disabled-with-a-hint rather
 * than offering a toggle that does nothing.
 */
export function InsightsOverviewArrangeSection({ id }: { id?: string }) {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  const flags = useFeatureFlags();
  const { layout, isLoading } = useInsightsLayoutQuery(isAuthenticated);

  const gatedOffSectionIds = useMemo(() => {
    const gated = new Set<InsightsSectionId>();
    if (!flags.briefing) {
      gated.add("daily-briefing");
      gated.add("period-review");
    }
    if (!user?.cycleTrackingEnabled) {
      gated.add("cycle-summary");
    }
    return gated;
  }, [flags.briefing, user?.cycleTrackingEnabled]);

  return (
    <section
      id={id}
      data-slot="insights-overview-arrange-section"
      aria-labelledby="insights-overview-arrange-title"
      className="space-y-3"
    >
      <SectionHeading
        icon={LayoutGrid}
        id="insights-overview-arrange-title"
        title={t("insights.settings.overviewTitle")}
        subtitle={t("insights.settings.overviewDescription")}
      />

      {/* Gate the editor mount until the layout GET settles. The editor seeds
          its draft once from `layout` on mount, which is the canonical default
          while in flight; mounting it early would let a "Fertig" save flush
          defaults over the user's real saved layout (the same QA-L1 gate the
          mother page applies to its "Anpassen" toggle). */}
      {isLoading ? (
        <SettingsCard
          className="text-muted-foreground flex items-center gap-2 text-sm"
          data-slot="insights-overview-arrange-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        </SettingsCard>
      ) : (
        <InsightsEditMode
          layout={layout}
          gatedOffSectionIds={gatedOffSectionIds}
          onClose={() => {}}
        />
      )}
    </section>
  );
}
