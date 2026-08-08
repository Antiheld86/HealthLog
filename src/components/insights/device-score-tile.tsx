"use client";

import type { ComponentType } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { DataSummary } from "@/lib/analytics/trends";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LearningGate } from "@/components/ui/learning-gate";
import { HealthChartDynamicMini } from "@/components/charts/health-chart-dynamic";
import { SectionHeading } from "@/components/ui/section-heading";
import { TileHeader } from "@/components/insights/tile-header";

/**
 * v1.17.1 — calm, data-gated readout for a device-native score that has no
 * generic assessment registry entry.
 *
 * The WHOOP / Oura / Polar score family (sleep performance, day strain, ANS
 * charge, …) is ingested end-to-end and lit in the AI chart-token allowlist,
 * but no page renders it. These metrics are deliberately OUTSIDE the
 * `metric-status-registry` (they're vendor-rolled-up scores, not signals the
 * app re-derives), so they carry no `<MetricStatusCard>`. This tile is the
 * surface for them: a title, the latest reading, the trailing-window mean, and
 * a small sparkline — server-authoritative throughout (it reads the stored
 * `summaries[type]` slice; it never recomputes).
 *
 * Calm posture (per the maintainer's standing card rules): one neutral card,
 * never an alarming colour, never a green-when-good / red-when-bad tint. The
 * caller passes the single chart line colour; the card chrome stays neutral.
 *
 * Data-gating is the caller's job: mount this tile only when
 * `summary.count > 0` (the parent section already reads the shared analytics
 * payload, so this avoids a second fetch and keeps the empty surface clean for
 * non-wearable users). When the series is present but still sparse
 * (`count < learningThreshold`), the tile swaps the sparkline for a
 * `<LearningGate>` so a two-night-old strap never paints a jagged
 * two-point line that reads as a trend.
 */

export interface DeviceScoreTileProps {
  /** The MeasurementType backing the readout + sparkline. */
  type: string;
  /** The stored summary slice for `type` (count / latest / mean). */
  summary: DataSummary | null | undefined;
  /** Localized tile title (e.g. the `measurements.type*` label). */
  title: string;
  /** Leading glyph. */
  icon: ComponentType<{ className?: string }>;
  /** Single chart-line colour. Never used for card chrome. */
  color: string;
  /** Unit suffix on the readout + chart (e.g. "%", "bpm", "kJ", "score"). */
  unit?: string;
  /** Optional decimal precision for the readout. Defaults to 0. */
  fractionDigits?: number;
  /**
   * Below this many readings the tile shows the `<LearningGate>` instead of a
   * sparkline. Defaults to 3 — enough points for a line to read honestly.
   */
  learningThreshold?: number;
  className?: string;
}

export function DeviceScoreTile({
  type,
  summary,
  title,
  icon: Icon,
  color,
  unit,
  fractionDigits = 0,
  learningThreshold = 3,
  className,
}: DeviceScoreTileProps) {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  // v1.32.26 — a type with a registered metric/imperial transform resolves its
  // display unit + conversion from the user's preference (e.g. the Oura body-
  // temperature DEVIATION renders in Δ°F for an imperial user). The affine
  // `toDisplay` is correct for the readout: the deviation transform carries no
  // offset (a Δ°C → Δ°F is factor-only), so no absolute shift leaks in.
  const unitDisplay = useUnitDisplay();
  const transform = unitDisplay.isTransformed(type)
    ? unitDisplay.transformFor(type)
    : null;
  const resolvedUnit = transform ? transform.displayUnit : unit;

  const count = summary?.count ?? 0;
  if (count === 0) return null;

  const latest = summary?.latest ?? null;
  const mean = summary?.mean ?? null;
  const isLearning = count < learningThreshold;

  const fmt = (value: number) =>
    (transform ? unitDisplay.toDisplay(type, value) : value).toLocaleString(
      resolveIntlLocale(locale),
      {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      },
    );

  return (
    <Card
      data-slot="device-score-tile"
      data-metric={type}
      className={className}
    >
      <CardHeader>
        {/* Canonical compact tile header — foreground `h-4` icon + `text-sm`
            title on the shared inset; the latest reading rides the `right`
            slot so it stays pinned to the row's right edge. */}
        <TileHeader
          size="sm"
          icon={Icon}
          title={title}
          className="min-w-0"
          titleClassName="min-w-0 truncate"
          right={
            latest != null ? (
              <span
                data-slot="device-score-latest"
                className="text-foreground text-lg font-semibold tabular-nums"
              >
                {fmt(latest)}
                {resolvedUnit ? (
                  <span className="text-muted-foreground ml-1 text-xs font-normal">
                    {resolvedUnit}
                  </span>
                ) : null}
              </span>
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {isLearning ? (
          <LearningGate
            compact
            bodySlot="device-score-learning"
            message={t("insights.deviceScore.learning")}
          />
        ) : (
          <>
            <div className="h-[120px] [--chart-height:96px]">
              <HealthChartDynamicMini
                types={[type]}
                title={title}
                colors={[color]}
                unit={resolvedUnit ?? ""}
                mini
                valueScale={transform ? transform.factor : undefined}
                valueOffset={transform ? (transform.offset ?? 0) : undefined}
                userTimezone={user?.timezone}
              />
            </div>
            {mean != null ? (
              <p
                data-slot="device-score-mean"
                className="text-muted-foreground text-xs"
              >
                {t("insights.deviceScore.average", { value: fmt(mean) })}
                {resolvedUnit ? ` ${resolvedUnit}` : ""}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export interface ConnectedDeviceScoreTileProps extends Omit<
  DeviceScoreTileProps,
  "summary"
> {
  /** Optional section heading rendered above the tile when it has data. */
  sectionTitle?: string;
  /** Optional Lucide glyph for the section heading. */
  sectionIcon?: ComponentType<{ className?: string }>;
  /** Optional section subtitle pinned to the heading's right edge. */
  sectionSubtitle?: string;
}

/**
 * v1.17.1 — a {@link DeviceScoreTile} that reads its own summary from the
 * shared `["analytics", "summaries"]` slice, so it can be dropped onto a page
 * that uses the `HealthKitMetricPage` scaffold (which owns its own analytics
 * read internally) without threading a summary prop down. Reuses the same
 * cache the host page already populated — no extra round-trip. Returns null
 * until the data lands and when the metric has no readings, so a host page
 * stays byte-identical for users without that device signal.
 */
export function ConnectedDeviceScoreTile({
  type,
  sectionTitle,
  sectionIcon,
  sectionSubtitle,
  ...tileProps
}: ConnectedDeviceScoreTileProps) {
  const { data } = useInsightsAnalytics("SLEEP_DURATION");
  const summary = data?.summaries?.[type];

  if ((summary?.count ?? 0) === 0) return null;

  const tile = <DeviceScoreTile type={type} summary={summary} {...tileProps} />;

  if (!sectionTitle || !sectionIcon) return tile;

  return (
    <section
      data-slot="connected-device-score"
      data-metric={type}
      className="space-y-3"
    >
      <SectionHeading
        icon={sectionIcon}
        title={sectionTitle}
        action={
          sectionSubtitle ? (
            <p className="text-muted-foreground text-xs">{sectionSubtitle}</p>
          ) : undefined
        }
      />
      {tile}
    </section>
  );
}
