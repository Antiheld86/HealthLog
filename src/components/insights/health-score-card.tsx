"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { ScoreAnatomyView } from "@/components/insights/derived/score-anatomy-view";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api/api-fetch";
import { useOptionalQueryClient } from "@/hooks/_internal/use-query-client-safe";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import type {
  HealthScoreReport,
  PillarReference,
  ScorePillarId,
  ScoreBand,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

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

export interface HealthScoreCardProps {
  report: HealthScoreReport;
  tension?: {
    band: ScoreBand;
    positive: string[];
    negative: string[];
  } | null;
  returnToBand?: { metricLabel: string; daysInside: number } | null;
  className?: string;
}

export function HealthScoreCard({
  report,
  tension,
  returnToBand,
  className,
}: HealthScoreCardProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit);
  const queryClient = useOptionalQueryClient();
  const [noticeDismissed, setNoticeDismissed] = useState(
    report.algorithmNotice?.dismissed ?? false,
  );

  function reasonText(reason: string): string {
    const key = REASON_KEY[reason] ?? "unavailable";
    return t(`insights.healthScore.reason.${key}`);
  }

  function referenceKindText(reference: PillarReference): string {
    return t(
      `insights.healthScore.referenceKind.${reference.kind === "clinical-threshold" ? "clinical" : reference.kind === "population-percentile" ? "population" : "guideline"}`,
    );
  }

  function formatReference(
    reference: PillarReference,
    label: string,
    source = reference.source,
  ): string {
    return t("insights.healthScore.referenceDetail", {
      label,
      source,
      kind: referenceKindText(reference),
      low: reference.low ?? t("insights.healthScore.openBound"),
      high: reference.high ?? t("insights.healthScore.openBound"),
    });
  }

  function observedText(pillar: ScorePillarResult): string {
    if (pillar.result.status !== "ok") return "";
    const observed = pillar.result.value.observed;
    if (pillar.id === "GLYCAEMIA" && observed.unit === "mg/dL") {
      return t("insights.healthScore.fastingObserved", {
        value: convertGlucose(observed.value, glucoseUnit),
        unit: glucoseUnit,
      });
    }
    if (pillar.id === "ACTIVITY") {
      return t("insights.healthScore.observedActivity", {
        value: observed.value,
      });
    }
    if (pillar.id === "SLEEP") {
      return t("insights.healthScore.observedSleep", {
        value: observed.value,
      });
    }
    if (pillar.id === "ADIPOSITY") {
      return t("insights.healthScore.observedAdiposity", {
        value: observed.value,
      });
    }
    if (pillar.id === "FITNESS") {
      return t("insights.healthScore.observedFitness", {
        value: observed.value,
        unit: observed.unit,
      });
    }
    return observed.label;
  }

  function scoredReferenceText(pillar: ScorePillarResult): string {
    if (pillar.result.status !== "ok") return "";
    const value = pillar.result.value;
    const reference = value.reference;
    if (pillar.id === "GLYCAEMIA" && value.observed.unit === "mg/dL") {
      const low =
        reference.low == null
          ? null
          : convertGlucose(reference.low, glucoseUnit);
      const high =
        reference.high == null
          ? null
          : convertGlucose(reference.high, glucoseUnit);
      const converted = { ...reference, low, high };
      return formatReference(
        converted,
        t("insights.healthScore.fastingReference", {
          low: low ?? "",
          high: high ?? "",
          unit: glucoseUnit,
        }),
      );
    }
    const label =
      pillar.id === "ACTIVITY"
        ? t("insights.healthScore.referenceActivity", {
            high: reference.high ?? "",
          })
        : pillar.id === "SLEEP"
          ? t("insights.healthScore.referenceSleep", {
              low: reference.low ?? "",
            })
          : pillar.id === "ADIPOSITY"
            ? t("insights.healthScore.referenceAdiposity", {
                high: reference.high ?? "",
              })
            : pillar.id === "FITNESS"
              ? t("insights.healthScore.referenceFitness", {
                  low: reference.low ?? "",
                  high: reference.high ?? "",
                  unit: value.observed.unit,
                })
              : pillar.id === "GLYCAEMIA"
                ? t("insights.healthScore.referenceHba1c", {
                    low: reference.low ?? "",
                    high: reference.high ?? "",
                  })
                : reference.label;
    return formatReference(
      reference,
      label,
      pillar.id === "LIPIDS"
        ? t("insights.healthScore.laboratoryReferenceSource")
        : reference.source,
    );
  }
  const composite = report.composite;
  const eligibleCount = report.pillars.filter(
    (pillar) => pillar.result.status === "ok",
  ).length;
  const contributors = report.pillars.map((pillar) => ({
    key: pillar.id,
    label: t(PILLAR_LABEL_KEY[pillar.id]),
    value: pillar.result.status === "ok" ? pillar.result.value.score : null,
    weight:
      pillar.result.status === "ok" && eligibleCount > 0
        ? 1 / eligibleCount
        : 0,
  }));
  const algorithmNotice = report.algorithmNotice;

  async function dismissAlgorithmNotice() {
    if (!algorithmNotice) return;
    setNoticeDismissed(true);
    try {
      await apiPost("/api/daily/digest/dismiss", {
        itemKey: algorithmNotice.itemKey,
      });
      queryClient?.setQueriesData(
        { queryKey: queryKeys.analytics() },
        (payload) =>
          markAlgorithmNoticeDismissed(payload, algorithmNotice.itemKey),
      );
      await queryClient?.invalidateQueries({
        queryKey: queryKeys.analytics(),
        refetchType: "active",
      });
    } catch {
      setNoticeDismissed(false);
    }
  }

  return (
    <div
      data-slot="health-score-card"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {algorithmNotice && !noticeDismissed ? (
        <div
          data-slot="health-score-algorithm-notice"
          className="border-border/70 bg-muted/35 flex items-start gap-3 rounded-lg border px-3 py-2.5"
        >
          <p className="text-muted-foreground min-w-0 flex-1 text-xs leading-relaxed">
            {t("insights.healthScore.algorithmChanged")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mt-1 -mr-2 h-9 w-9 shrink-0"
            aria-label={t("insights.healthScore.dismissAlgorithmChanged")}
            onClick={() => void dismissAlgorithmNotice()}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ) : null}

      <ScoreAnatomyView
        title={t("insights.healthScore.label")}
        score={composite.status === "ok" ? composite.value.score : null}
        band={composite.status === "ok" ? composite.value.band : undefined}
        caption={
          composite.status === "ok"
            ? t(`insights.healthScore.band.${composite.value.band}`)
            : undefined
        }
        contributors={contributors}
        coverage={composite.coverage}
        confidence={composite.status === "ok" ? composite.confidence : null}
        provenance={composite.provenance}
        method={t("insights.healthScore.method")}
        insufficient={composite.status !== "ok"}
        insufficientNote={
          composite.status === "insufficient"
            ? t("insights.healthScore.insufficient", {
                count: composite.coverage.presentInputs,
              })
            : undefined
        }
        showProvisionalRing={false}
        className="border-border/70 bg-card/80"
      />

      {composite.status === "ok" ||
      report.deltaReason ||
      report.restMode?.active ? (
        <div className="border-border/70 bg-card/80 space-y-2 rounded-xl border p-4">
          {composite.status === "ok" ? (
            <>
              <p className="text-foreground text-xs font-semibold">
                {t("insights.healthScore.composition", {
                  pillars: composite.value.composition
                    .map((id) => t(PILLAR_LABEL_KEY[id]))
                    .join(", "),
                })}
              </p>
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
            <p className="text-muted-foreground text-xs">
              {t("insights.healthScore.restMode", {
                since: report.restMode.since ?? t("insights.healthScore.none"),
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      <ul className="space-y-2" data-slot="health-score-pillars">
        {report.pillars.map((pillar) => (
          <li
            key={pillar.id}
            data-pillar={pillar.id}
            data-status={pillar.result.status}
            className="border-border/70 bg-card/80 rounded-xl border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-semibold">
                  {t(PILLAR_LABEL_KEY[pillar.id])}
                </p>
                {pillar.result.status === "ok" ? (
                  <>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("insights.healthScore.observed", {
                        value: observedText(pillar),
                      })}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("insights.healthScore.reference", {
                        value: scoredReferenceText(pillar),
                      })}
                    </p>
                    {pillar.result.value.personalReference ? (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t("insights.healthScore.personalReference", {
                          value: formatReference(
                            pillar.result.value.personalReference,
                            pillar.result.value.personalReference.label,
                            t("insights.healthScore.personalTargetSource"),
                          ),
                        })}
                      </p>
                    ) : null}
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("insights.healthScore.source", {
                        source:
                          pillar.result.value.observed.sources.join(", ") ||
                          pillar.result.provenance.source,
                        date: pillar.result.value.observed.asOf,
                      })}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("insights.healthScore.pillarInsufficient", {
                        reason: reasonText(pillar.result.reason),
                      })}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("insights.healthScore.source", {
                        source: pillar.result.provenance.source,
                        date: pillar.result.provenance.computedAt,
                      })}
                    </p>
                  </>
                )}
              </div>
              {pillar.result.status === "ok" ? (
                <span className="text-foreground text-lg font-semibold tabular-nums">
                  {Math.round(pillar.result.value.score)}
                </span>
              ) : null}
            </div>
            <CoverageMeter
              coverage={pillar.result.coverage}
              confidence={
                pillar.result.status === "ok"
                  ? pillar.result.confidence
                  : undefined
              }
              size="sm"
              className="mt-3"
            />
          </li>
        ))}
      </ul>

      <WeightGoalRow report={report} />
      {tension || returnToBand ? (
        <div
          data-slot="health-score-independent-context"
          className="border-border/70 bg-card/80 space-y-2 rounded-xl border p-4"
        >
          {tension ? (
            <p className="text-muted-foreground text-xs">
              {t("insights.healthScore.tension", {
                positive: tension.positive.join(", "),
                negative: tension.negative.join(", "),
              })}
            </p>
          ) : null}
          {returnToBand ? (
            <p className="text-muted-foreground text-xs">
              {t("insights.healthScore.returnToBand", {
                metric: returnToBand.metricLabel,
                days: returnToBand.daysInside,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WeightGoalRow({ report }: { report: HealthScoreReport }) {
  const { t } = useTranslations();
  const goal = report.weightGoal;
  const units = useUnitDisplay();
  const unit = units.unitFor("WEIGHT");
  return (
    <div
      data-slot="health-score-weight-goal"
      data-status={goal.status}
      className="border-border/70 bg-card/80 rounded-xl border p-4"
    >
      <p className="text-foreground text-sm font-semibold">
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
      <p className="text-muted-foreground mt-2 text-[11px]">
        {t("insights.healthScore.weightGoal.notScored")}
      </p>
    </div>
  );
}
