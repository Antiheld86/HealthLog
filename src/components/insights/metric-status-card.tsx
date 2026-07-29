"use client";

import type { ReactNode } from "react";

import { useInsightMetricStatus } from "@/hooks/use-insight-status";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import {
  scopeSourceFromMetricKey,
  scopeSourceMetricLabelKey,
} from "@/components/insights/coach-metric-scope";

interface MetricStatusCardProps {
  /** The registry metric id the generic assessment route keys on. */
  metric: MetricStatusMetricId;
  /** The leading glyph (Sparkles for the generic scaffold, Moon for sleep). */
  icon: ReactNode;
  /**
   * Gate the fetch on the page having data, so an insufficient-data page
   * never fires an assessment round-trip. The hook still runs on every
   * render (rules of hooks); `enabled` decides whether it talks to the
   * network.
   */
  enabled: boolean;
}

/**
 * v1.8.7.1 — shared mount for the generic per-metric assessment card.
 *
 * Owns the `useInsightMetricStatus` hook + the eight-prop `<InsightStatusCard>`
 * wiring (`status?.x ?? default`) so the HealthKit metric scaffold and the
 * bespoke sleep page consume one seam instead of repeating the block. Only
 * the icon differs between the two sites; everything else is identical.
 */
export function MetricStatusCard({
  metric,
  icon,
  enabled,
}: MetricStatusCardProps) {
  const { t } = useTranslations();
  const mounted = useMounted();
  const { data: status, isLoading } = useInsightMetricStatus(metric, enabled);

  // v1.21.0 (C4 H2) — narrow the Coach hand-off to this metric's snapshot
  // source when one exists; the registry id is a `MeasurementType`-style
  // token, which `scopeSourceFromMetricKey` resolves for the metrics that
  // carry a snapshot block. Unmapped metrics still get a metric-named
  // opener, just against the default snapshot.
  const coachSource = scopeSourceFromMetricKey(metric);
  // Prefer the EXISTING localised measurement-name key for the auto-sent
  // preset so the opener reads in the user's language; fall back to the
  // humanised token only for metrics without a localised name.
  const coachLabelKey = scopeSourceMetricLabelKey(coachSource);
  const coachQuestion = t("insights.coach.assessmentPrompt", {
    metric: coachLabelKey
      ? t(coachLabelKey)
      : metric.toLowerCase().replace(/_/g, " "),
  });

  return (
    <InsightStatusCard
      title={t("insights.assessmentTitle")}
      icon={icon}
      text={status?.text ?? null}
      hasProvider={status?.hasProvider ?? false}
      updatedAt={status?.updatedAt ?? null}
      assessment={status?.assessment}
      coachQuestion={coachQuestion}
      coachScope={coachSource ? { metric: coachSource } : undefined}
      coachAutoSend
      // Same hydration gate as `<SlugInsightStatusCard>`: the hook is
      // `enabled: isAuthenticated && enabled`, and both inputs can settle
      // before a late-hydrating boundary replays its first render — the
      // loading branch then disagrees with the server HTML (React #418).
      loading={!mounted || isLoading}
      preparing={status?.preparing ?? false}
    />
  );
}
