"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InfoPopover } from "@/components/ui/info-popover";
import { LearningGate } from "@/components/ui/learning-gate";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import {
  BAND_PROGRESS_CLASS,
  bandForScore,
  clampScore,
} from "@/components/insights/derived/band-tokens";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { ProvenanceExplainer } from "@/components/insights/derived/provenance-explainer";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import { METRIC_PROVENANCE } from "@/components/insights/derived/standards";
import {
  pillarDetailLines,
  pillarObservedText,
  type PillarDetailContext,
} from "@/components/insights/health-score-pillar-detail";
import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { resolveGlucoseUnit } from "@/lib/glucose";
import type {
  HealthScoreReport,
  ScorePillarId,
  ScoreBand,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * The Health Score surface: one card, one score, one place.
 *
 * Pre-rework the score had two mounts — a compact face in the hero band and a
 * nine-block stack further down the overview that only rendered while the
 * daily-briefing flag was on. The stack is now a single progressive-disclosure
 * card pinned directly under the hero, and the hero band is the full-width
 * greeting again.
 *
 * Collapsed reads as the score face: the ring, the band sentence, the weekly
 * delta (or the honest reason there is none), Rest Mode, the two ambient
 * context lines, and the coverage meter. Expanded adds the pillar grid, the
 * named list of pillars that are not scored yet, the personal weight goal, and
 * the method footer with its cited standard.
 *
 * Absence stays absence: a pillar the server gated as `insufficient` is listed
 * by name with its reason instead of being drawn as a zero, and a pillar whose
 * read FAILED is a visible error row with a retry, never silence.
 */

const PILLAR_LABEL_KEY: Record<ScorePillarId, string> = {
  BLOOD_PRESSURE: "insights.healthScore.pillar.bloodPressure",
  GLYCAEMIA: "insights.healthScore.pillar.glycaemia",
  ACTIVITY: "insights.healthScore.pillar.activity",
  SLEEP: "insights.healthScore.pillar.sleep",
  ADIPOSITY: "insights.healthScore.pillar.adiposity",
  WELLBEING: "insights.healthScore.pillar.wellbeing",
  FITNESS: "insights.healthScore.pillar.fitness",
  LIPIDS: "insights.healthScore.pillar.lipids",
};

const REASON_KEY: Record<string, string> = {
  read_failed: "readFailed",
  not_tracked: "notTracked",
  missing_reference_profile: "missingProfile",
  missing_height: "missingHeight",
  incomplete_or_stale_panel: "incompletePanel",
  crisis_signposting: "crisis",
  below_day_floor_or_stale: "insufficientHistory",
  below_reading_floor: "insufficientHistory",
  stale_or_untracked: "insufficientHistory",
  unverified_or_stale: "insufficientHistory",
  below_reading_floor_or_stale: "insufficientHistory",
  below_night_floor_or_stale: "insufficientHistory",
  stale: "insufficientHistory",
};

/**
 * v1.21.2 (A5) — readiness contributor keys the Tension Verdict surfaces.
 * Kept as a local string union so the client never imports the server
 * derived-engine types. Localised through the existing
 * `insights.derived.composite.READINESS.component.{key}` labels.
 */
export type ReadinessContributorKey =
  "rhr" | "hrv" | "sleep" | "respiratory" | "mood";

/**
 * v1.21.2 (A5) — readiness contributor key → existing localised label key.
 * Reuses the score-anatomy contributor labels so the Tension Verdict reads the
 * same names the wellness ring's anatomy view renders — no new keys.
 */
const TENSION_CONTRIBUTOR_LABEL_KEY: Record<ReadinessContributorKey, string> = {
  rhr: "insights.derived.composite.READINESS.component.rhr",
  hrv: "insights.derived.composite.READINESS.component.hrv",
  sleep: "insights.derived.composite.READINESS.component.sleep",
  respiratory: "insights.derived.composite.READINESS.component.respiratory",
  mood: "insights.derived.composite.READINESS.component.mood",
};

/**
 * v1.21.2 (A6) — `MeasurementType` → existing localised metric-name key
 * (`measurements.type*`). Only the salient deviation vitals the
 * return-to-baseline detector scans need an entry; an unmapped type falls back
 * to a prettified raw form so a new type never blanks.
 */
const RETURN_METRIC_LABEL_KEY: Record<string, string> = {
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESPIRATORY_RATE: "measurements.typeRespiratoryRate",
  WEIGHT: "measurements.typeWeight",
};

export function markAlgorithmNoticeDismissed(
  payload: unknown,
  itemKey: string,
): unknown {
  if (!payload || typeof payload !== "object" || !("healthScore" in payload)) {
    return payload;
  }
  const healthScore = payload.healthScore;
  if (
    !healthScore ||
    typeof healthScore !== "object" ||
    !("algorithmNotice" in healthScore)
  ) {
    return payload;
  }
  const notice = healthScore.algorithmNotice;
  if (
    !notice ||
    typeof notice !== "object" ||
    !("itemKey" in notice) ||
    notice.itemKey !== itemKey
  ) {
    return payload;
  }
  return {
    ...payload,
    healthScore: {
      ...healthScore,
      algorithmNotice: { ...notice, dismissed: true },
    },
  };
}

/** The reason a pillar was gated, or null when it carries a score. */
function gateReason(pillar: ScorePillarResult): string | null {
  return pillar.result.status === "insufficient" ? pillar.result.reason : null;
}

export interface HealthScoreCardProps {
  report: HealthScoreReport;
  /**
   * v1.21.2 (A5) — Tension Verdict, server-resolved + locale-agnostic. `band`
   * is the readiness composite's band; `positive` / `negative` carry the
   * readiness contributor KEYS. Null on a coherent day (or under a clinical
   * red-flag suppress).
   */
  tension?: {
    band: ScoreBand;
    positive: ReadinessContributorKey[];
    negative: ReadinessContributorKey[];
  } | null;
  /**
   * v1.21.2 (A6) — return-to-baseline, server-resolved + locale-agnostic.
   * `metricType` is a `MeasurementType` this card maps to its localised metric
   * name. Null when no salient metric returned from a genuine prior
   * out-of-band run.
   */
  returnToBand?: { metricType: string; daysInside: number } | null;
  /** Retry for a pillar whose read failed — wired to the analytics refetch. */
  onRetry?: () => void;
  className?: string;
}

export function HealthScoreCard({
  report,
  tension = null,
  returnToBand = null,
  onRetry,
  className,
}: HealthScoreCardProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const regionId = useId();

  const detail: PillarDetailContext = {
    t,
    glucoseUnit: resolveGlucoseUnit(user?.glucoseUnit),
  };

  function reasonText(reason: string): string {
    const key = REASON_KEY[reason] ?? "unavailable";
    return t(`insights.healthScore.reason.${key}`);
  }

  const composite = report.composite;
  const scored = report.pillars.filter((p) => p.result.status === "ok");
  const readFailed = report.pillars.filter(
    (p) => gateReason(p) === "read_failed",
  );
  // A failed read is not absence, so it never joins the "not scored yet" list;
  // it gets its own error row above. Safety copy leads the list — signposting
  // is content, never buried meta.
  const notScored = report.pillars
    .filter((p) => {
      const reason = gateReason(p);
      return reason !== null && reason !== "read_failed";
    })
    .sort(
      (a, b) =>
        Number(gateReason(b) === "crisis_signposting") -
        Number(gateReason(a) === "crisis_signposting"),
    );

  // Only forwarded when a real disagreement is present on BOTH sides; the
  // server resolver already enforces that, but the guard keeps the card from
  // rendering a one-sided line.
  const tensionLine =
    tension && tension.positive.length > 0 && tension.negative.length > 0
      ? t("insights.healthScore.tension", {
          positive: tension.positive
            .map((k) => t(TENSION_CONTRIBUTOR_LABEL_KEY[k]))
            .join(", "),
          negative: tension.negative
            .map((k) => t(TENSION_CONTRIBUTOR_LABEL_KEY[k]))
            .join(", "),
        })
      : null;

  const returnToBandLine = returnToBand
    ? t("insights.healthScore.returnToBand", {
        metric: RETURN_METRIC_LABEL_KEY[returnToBand.metricType]
          ? t(RETURN_METRIC_LABEL_KEY[returnToBand.metricType])
          : returnToBand.metricType.replace(/_/g, " ").toLowerCase(),
        days: returnToBand.daysInside,
      })
    : null;

  return (
    <Card
      data-slot="health-score-card"
      data-status={composite.status}
      className={cn("animate-insight-in", className)}
    >
      <CardHeader>
        <TileHeader title={t("insights.healthScore.label")} titleAs="h2" />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The score face. The ring keeps its own identity block; everything
            that qualifies the number sits beside it, so a person reads the
            score and the reason for it in one pass. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex justify-center sm:justify-start">
            <ScoreRing
              score={composite.status === "ok" ? composite.value.score : null}
              band={
                composite.status === "ok" ? composite.value.band : undefined
              }
              size="md"
              label={t("insights.derived.anatomy.outOf")}
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            {composite.status === "ok" ? (
              <p
                data-slot="health-score-band"
                className="text-foreground text-sm"
              >
                {t(`insights.healthScore.band.${composite.value.band}`)}
              </p>
            ) : null}
            {report.delta != null ? (
              <p
                data-slot="health-score-delta"
                className="text-muted-foreground text-xs tabular-nums"
              >
                {t("insights.healthScore.delta", {
                  delta: report.delta > 0 ? `+${report.delta}` : report.delta,
                })}
              </p>
            ) : report.deltaReason ? (
              <p
                data-slot="health-score-delta-reason"
                className="text-muted-foreground text-xs"
              >
                {t(`insights.healthScore.deltaReason.${report.deltaReason}`)}
              </p>
            ) : null}
            {report.restMode?.active ? (
              <p
                data-slot="health-score-rest-mode"
                className="text-muted-foreground text-xs"
              >
                {t("insights.healthScore.restMode", {
                  since:
                    report.restMode.since ?? t("insights.healthScore.none"),
                })}
              </p>
            ) : null}
            {tensionLine ? (
              <p
                data-slot="health-score-tension"
                className="text-muted-foreground text-xs"
              >
                {tensionLine}
              </p>
            ) : null}
            {returnToBandLine ? (
              <p
                data-slot="health-score-return-to-band"
                className="text-muted-foreground text-xs"
              >
                {returnToBandLine}
              </p>
            ) : null}
          </div>
        </div>

        {composite.status !== "ok" ? (
          <LearningGate
            variant="bordered"
            bodySlot="health-score-insufficient"
            message={t("insights.healthScore.insufficient", {
              count: composite.coverage.presentInputs,
            })}
          />
        ) : null}

        <CoverageMeter
          coverage={composite.coverage}
          confidence={
            composite.status === "ok" ? composite.confidence : undefined
          }
          size="md"
        />

        {/* Progressive disclosure. No Collapsible primitive exists in the UI
            kit, so this is the same accessible button + region shape the
            glucose panel ships: `aria-expanded` on the trigger,
            `aria-controls` + `hidden` on the region. */}
        <div className="border-border border-t pt-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={regionId}
            data-slot="health-score-anatomy-toggle"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-2 rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span>{t("insights.healthScore.anatomyToggle")}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>

          <div
            id={regionId}
            hidden={!open}
            data-slot="health-score-anatomy-region"
            className="space-y-4 pt-3"
          >
            {scored.length > 0 ? (
              <ul
                data-slot="health-score-pillars"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                {scored.map((pillar) => (
                  <PillarCell key={pillar.id} pillar={pillar} detail={detail} />
                ))}
              </ul>
            ) : null}

            {readFailed.map((pillar) => (
              <QueryErrorRow
                key={pillar.id}
                slot="health-score-pillar-error"
                retrySlot="health-score-pillar-retry"
                message={
                  <>
                    {t(PILLAR_LABEL_KEY[pillar.id])}
                    {": "}
                    {reasonText("read_failed")}
                  </>
                }
                onRetry={onRetry}
              />
            ))}

            {notScored.length > 0 ? (
              <div data-slot="health-score-not-scored" className="space-y-2">
                <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {t("insights.healthScore.notScored", {
                    count: notScored.length,
                  })}
                </p>
                <ul className="space-y-1">
                  {notScored.map((pillar) => {
                    const reason = gateReason(pillar) ?? "";
                    const crisis = reason === "crisis_signposting";
                    return (
                      <li
                        key={pillar.id}
                        data-pillar={pillar.id}
                        data-reason={reason}
                        className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2"
                      >
                        <span className="text-foreground text-xs font-medium">
                          {t(PILLAR_LABEL_KEY[pillar.id])}
                        </span>
                        <span
                          className={cn(
                            "text-xs",
                            crisis
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {reasonText(reason)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <WeightGoalRow report={report} />

            <div data-slot="health-score-method" className="space-y-1">
              {composite.status === "ok" ? (
                <>
                  <p className="text-muted-foreground text-xs">
                    {t("insights.healthScore.bandSetter", {
                      pillar: composite.value.bandSetter
                        ? t(PILLAR_LABEL_KEY[composite.value.bandSetter])
                        : t("insights.healthScore.none"),
                    })}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("insights.healthScore.versionAndNoise", {
                      version: report.scoreVersion,
                      noise: composite.value.noiseFloor,
                    })}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {t("insights.healthScore.methodVersion", {
                    version: report.scoreVersion,
                  })}
                </p>
              )}
              <ProvenanceExplainer
                provenance={composite.provenance}
                method={t(METRIC_PROVENANCE.HEALTH_SCORE.methodKey)}
                standard={METRIC_PROVENANCE.HEALTH_SCORE.standard}
                className="block"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One scored pillar: name + score, a band-tinted impact bar, and the observed
 * line with its detail popover and coverage meter. The reference band, the
 * personal target and the source live in the popover — the same strings as
 * before, one tap away instead of four permanent lines per pillar.
 */
function PillarCell({
  pillar,
  detail,
}: {
  pillar: ScorePillarResult;
  detail: PillarDetailContext;
}) {
  const { t } = useTranslations();
  if (pillar.result.status !== "ok") return null;
  const score = clampScore(pillar.result.value.score);
  const band = bandForScore(score);
  const lines = pillarDetailLines(pillar, detail);

  return (
    <li
      data-pillar={pillar.id}
      data-status="ok"
      className="border-border/70 space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-foreground min-w-0 text-sm font-medium">
          {t(PILLAR_LABEL_KEY[pillar.id])}
        </span>
        <span className="text-foreground text-lg font-semibold tabular-nums">
          {Math.round(score)}
        </span>
      </div>
      <div
        className="bg-muted/40 h-1.5 w-full overflow-hidden rounded-full"
        role="presentation"
      >
        <div
          data-slot="health-score-pillar-bar"
          className={cn("h-full rounded-full", BAND_PROGRESS_CLASS[band])}
          style={{ width: `${score}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 text-xs">
          {t("insights.healthScore.observed", {
            value: pillarObservedText(pillar, detail),
          })}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <InfoPopover
            content={lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            bodyDataSlot="health-score-pillar-detail"
          />
          <CoverageMeter
            coverage={pillar.result.coverage}
            confidence={pillar.result.confidence}
            size="sm"
          />
        </span>
      </div>
    </li>
  );
}

/**
 * The personal weight goal: an inner tile inside the disclosure, deliberately
 * NOT a pillar cell, because it is context the user set for themselves and it
 * never moves the score.
 */
function WeightGoalRow({ report }: { report: HealthScoreReport }) {
  const { t } = useTranslations();
  const goal = report.weightGoal;
  const units = useUnitDisplay();
  const unit = units.unitFor("WEIGHT");
  return (
    <div
      data-slot="health-score-weight-goal"
      data-status={goal.status}
      className="border-border/70 rounded-lg border p-3"
    >
      <p className="text-foreground text-sm font-medium">
        {t("insights.healthScore.weightGoal.title")}
      </p>
      {goal.status === "ok" ? (
        <>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("insights.healthScore.weightGoal.value", {
              current: units.toDisplay("WEIGHT", goal.value.currentKg),
              min: units.toDisplay("WEIGHT", goal.value.target.min),
              max: units.toDisplay("WEIGHT", goal.value.target.max),
              distance: units.toDisplayDelta("WEIGHT", goal.value.distanceKg),
              unit,
            })}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {goal.value.deltaKg == null
              ? t("insights.healthScore.weightGoal.noDelta")
              : t("insights.healthScore.weightGoal.delta", {
                  delta: units.toDisplayDelta("WEIGHT", goal.value.deltaKg),
                  unit,
                })}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("insights.healthScore.source", {
              source: goal.value.source,
              date: goal.value.asOf,
            })}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">
          {t(`insights.healthScore.weightGoal.${goal.reason}`)}
        </p>
      )}
      <CoverageMeter
        coverage={goal.coverage}
        confidence={goal.status === "ok" ? goal.confidence : undefined}
        size="sm"
        className="mt-3"
      />
      <p className="text-muted-foreground mt-2 text-xs">
        {t("insights.healthScore.weightGoal.notScored")}
      </p>
    </div>
  );
}

/**
 * The pinned slot's reserve while the analytics payload is in flight. Mirrors
 * the COLLAPSED footprint — header, ring, face lines, coverage meter, trigger
 * row — so first paint lands at the card's real height and the resolved card
 * is a swap rather than a push. Decorative: the card announces nothing while
 * it loads.
 */
export function HealthScoreCardSkeleton({ className }: { className?: string }) {
  return (
    <Card
      data-slot="health-score-card-skeleton"
      aria-hidden="true"
      className={className}
    >
      <CardHeader>
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* The `md` ring paints at a fixed 168 px box; the reserve matches it
              exactly so the swap moves nothing. */}
          <Skeleton className="size-[168px] shrink-0 self-center rounded-full sm:self-auto" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <Skeleton className="h-3 w-28" />
        <div className="border-border border-t pt-3">
          <Skeleton className="h-11 w-full rounded-sm" />
        </div>
      </CardContent>
    </Card>
  );
}
