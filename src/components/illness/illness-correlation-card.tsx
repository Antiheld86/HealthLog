"use client";

/**
 * v1.18.1 P3 — the per-episode retrospective correlation card ("How it
 * unfolded"). Server-authoritative + coverage-gated: it pattern-matches the
 * `Derived<T>` `status` and renders "still learning" when the signal is thin,
 * NEVER a fabricated number. Retrospective only — never a prediction or a
 * diagnosis. Neutral palette throughout (the med-card no-colour rule
 * generalised); the red-flag is a calm "worth a closer look" note, framed to
 * escalate without alarming colour.
 */
import { ArrowDown, ArrowUp, Info } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { useIllnessCorrelation } from "./use-illness";
import type { IllnessCorrelationValue, IllnessVitalDeviation } from "./types";

/** Translate a MeasurementType to its illness-surface label. */
function useVitalLabel() {
  const { t } = useTranslations();
  return (type: string) => t(`illness.vital.${type}`);
}

function DeviationRow({ d }: { d: IllnessVitalDeviation }) {
  const { t } = useTranslations();
  const vitalLabel = useVitalLabel();
  const Arrow = d.direction === "above" ? ArrowUp : ArrowDown;
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="text-foreground min-w-0 truncate">
        {vitalLabel(d.type)}
      </span>
      <span className="text-muted-foreground flex shrink-0 items-center gap-1 tabular-nums">
        <Arrow className="h-3.5 w-3.5" aria-hidden />
        {t(`illness.correlation.direction.${d.direction}`)}
      </span>
    </li>
  );
}

/** Round asleep-minutes to a friendly hours figure (one decimal). */
function hoursFromMinutes(minutes: number): string {
  return (Math.round((minutes / 60) * 10) / 10).toString();
}

function CorrelationBody({ value }: { value: IllnessCorrelationValue }) {
  const { t } = useTranslations();
  const gap = value.recoveryGapDays;
  // Driver-aware copy: when the user's logged symptom curve drove the gap, name
  // the symptoms ("…before your symptoms eased"); otherwise the existing
  // vital-driven phrasing. Clinically calm — observation, never prediction.
  const symptomDriven = value.gapDriverType === "FUNCTIONAL_IMPACT";
  // Sleep-as-context: a neutral observation subordinate to the gap, withheld by
  // the engine on thin data — never a recovery claim, never a second gap.
  const sleep = value.sleepContext;

  // The engine can return `ok` with NO findings — a mild episode where nothing
  // strayed notably from the personal band, still active with no recovery gap,
  // and no red flag. Without this the card body rendered empty under its "how
  // it progressed" heading, reading as if nothing was recorded at all. Show a
  // calm, honest line instead (retrospective, never a fabricated finding).
  const hasContent =
    value.redFlags.length > 0 ||
    gap !== null ||
    value.preOnset.length > 0 ||
    value.nadir.length > 0;

  if (!hasContent) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("illness.correlation.settled")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {value.redFlags.length > 0 ? (
        <div className="border-border bg-muted/40 rounded-lg border p-3">
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.redFlagTitle")}
          </p>
          <ul className="text-muted-foreground mt-1 space-y-1 text-sm">
            {value.redFlags.map((f) => (
              <li key={`${f.type}:${f.reason}`}>
                {f.reason === "sustained_low_spo2"
                  ? t("illness.correlation.redFlagSpo2")
                  : t("illness.correlation.redFlagFever")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gap !== null ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.recoveryGapTitle")}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {gap > 0
              ? t(
                  symptomDriven
                    ? "illness.correlation.recoveryGapLagSymptom"
                    : "illness.correlation.recoveryGapLag",
                  { days: gap },
                )
              : gap < 0
                ? t(
                    symptomDriven
                      ? "illness.correlation.recoveryGapLeadSymptom"
                      : "illness.correlation.recoveryGapLead",
                    { days: Math.abs(gap) },
                  )
                : t("illness.correlation.recoveryGapSame")}
          </p>
          {sleep ? (
            <p className="text-muted-foreground mt-1.5 text-xs">
              {t(
                sleep.deltaMinutes > 0
                  ? "illness.correlation.sleepContextMore"
                  : "illness.correlation.sleepContextLess",
                { hours: hoursFromMinutes(Math.abs(sleep.deltaMinutes)) },
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {value.preOnset.length > 0 ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.preOnsetTitle")}
          </p>
          <p className="text-muted-foreground mt-1 mb-2 text-xs">
            {t("illness.correlation.preOnsetBody")}
          </p>
          <ul className="space-y-1.5">
            {value.preOnset.map((d) => (
              <DeviationRow key={`pre:${d.type}`} d={d} />
            ))}
          </ul>
        </div>
      ) : null}

      {value.nadir.length > 0 ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.nadirTitle")}
          </p>
          <p className="text-muted-foreground mt-1 mb-2 text-xs">
            {t("illness.correlation.nadirBody")}
          </p>
          <ul className="space-y-1.5">
            {value.nadir.map((d) => (
              <DeviationRow key={`nadir:${d.type}`} d={d} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function IllnessCorrelationCard({ episodeId }: { episodeId: string }) {
  const { t } = useTranslations();
  const { data, isLoading, isError } = useIllnessCorrelation(episodeId);

  return (
    <Card>
      <CardHeader>
        <TileHeader
          icon={Info}
          titleAs="h2"
          title={t("illness.correlation.title")}
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError || !data || data.status !== "ok" || !data.value ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.correlation.learning")}
          </p>
        ) : (
          <CorrelationBody value={data.value} />
        )}
      </CardContent>
    </Card>
  );
}
