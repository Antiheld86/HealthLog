"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronLeft, HeartPulse, Info } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/ui/section-heading";
import { EcgWaveform } from "@/components/insights/ecg-waveform";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.28.50 — ECG recording surface (list → detail).
 *
 * Renders the user's ECG recordings synced from a single-lead device
 * (Withings ScanWatch today): a list of strips, each opening a detail view
 * with the `EcgWaveform` trace, the recording metadata, and the DEVICE's
 * own classification.
 *
 * NON-DIAGNOSTIC (load-bearing, do not soften — mirrors `RhythmEventsCard`):
 * the surface shows only the waveform (raw data), the metadata, and the
 * recording device's own result, attributed unambiguously to the device
 * ("Recorded result: …, as reported by the recording device"). HealthLog
 * generates NO interpretation of the waveform — no measured intervals, no
 * beat/P/QRS/T annotation, no risk score, no verdict of its own. A
 * permanent, non-dismissible disclaimer states this, and any non-normal
 * device result additionally carries a "discuss with a clinician" note.
 * All copy renders as plain React text children (no markdown library — the
 * standing XSS rule).
 *
 * Data-availability-gated: the section un-mounts entirely (`return null`)
 * when the user has no recordings — never an empty / alarming card.
 */

type EcgClassification = "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;

interface EcgRecordingListItem {
  id: string;
  recordedAt: string;
  durationSeconds: number | null;
  samplingFrequency: number;
  sampleCount: number;
  averageHeartRate: number | null;
  lead: string | null;
  classification: EcgClassification;
  source: string;
  hasWaveform: boolean;
}

interface EcgListResponse {
  recordings: EcgRecordingListItem[];
  hasRecordings: boolean;
}

interface EcgDetailResponse {
  recordedAt: string;
  durationSeconds: number | null;
  samplingFrequency: number;
  averageHeartRate: number | null;
  lead: string | null;
  classification: EcgClassification;
  source: string;
  samples: number[];
  decimated: boolean;
}

/** The device verdict, surfaced verbatim and attributed to the device. */
const RESULT_LABEL_KEYS: Record<string, string> = {
  IRREGULAR: "insights.ecg.result.irregular",
  NOT_DETECTED: "insights.ecg.result.notDetected",
  INCONCLUSIVE: "insights.ecg.result.inconclusive",
};

/** Non-normal device results trigger the "discuss with a clinician" note. */
function isNonNormal(classification: EcgClassification): boolean {
  return classification === "IRREGULAR" || classification === "INCONCLUSIVE";
}

interface EcgSectionProps {
  enabled?: boolean;
  className?: string;
  /**
   * v1.30 — suppress the internal `<SectionHeading>` when the section is
   * hosted on the routed `/insights/ecg` sub-page, whose `<SubPageShell>`
   * already renders the page `<h1>`. Defaults to `false` so the overview
   * teaser keeps its own heading unchanged. Purely presentational — the
   * non-diagnostic disclaimer + waveform logic are untouched.
   */
  hideHeading?: boolean;
}

export function EcgSection({
  enabled = true,
  className,
  hideHeading = false,
}: EcgSectionProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.insightsEcgList(),
    queryFn: async () => {
      try {
        return await apiGet<EcgListResponse>("/api/insights/ecg");
      } catch {
        throw new Error(t("insights.ecg.loadError"));
      }
    },
    enabled: enabled && isAuthenticated,
  });

  // Data-availability gate — never paint an empty card.
  if (isLoading || !data || !data.hasRecordings) return null;

  const selected =
    selectedId != null
      ? (data.recordings.find((r) => r.id === selectedId) ?? null)
      : null;

  function resultLabel(classification: EcgClassification): string | null {
    if (!classification) return null;
    const key = RESULT_LABEL_KEYS[classification];
    return key ? t(key) : null;
  }

  return (
    <section
      id="ecg"
      data-slot="ecg-section"
      aria-label={t("insights.ecg.sectionTitle")}
      className={cn("scroll-mt-24 space-y-3", className)}
    >
      {!hideHeading && (
        <SectionHeading
          icon={Activity}
          title={t("insights.ecg.sectionTitle")}
        />
      )}
      <InsightSectionCard slot="ecg-card" className="border-border">
        {selected ? (
          <EcgDetail
            recording={selected}
            resultLabel={resultLabel(selected.classification)}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {t("insights.ecg.sectionIntro")}
            </p>
            <ol data-slot="ecg-list" className="space-y-3">
              {data.recordings.map((rec) => {
                const label = resultLabel(rec.classification);
                const rowInner = (
                  <>
                    <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
                      <HeartPulse className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-foreground text-sm font-medium">
                        {fmt.dateTime(new Date(rec.recordedAt))}
                      </p>
                      {label && (
                        <p
                          data-slot="ecg-row-result"
                          className="text-muted-foreground text-sm"
                        >
                          {label}
                        </p>
                      )}
                      {rec.averageHeartRate != null && (
                        <p className="text-muted-foreground text-xs">
                          {t("insights.ecg.meta.bpmValue", {
                            bpm: rec.averageHeartRate,
                          })}
                        </p>
                      )}
                    </div>
                  </>
                );
                return (
                  <li
                    key={rec.id}
                    data-slot="ecg-row"
                    data-classification={rec.classification ?? "NONE"}
                    className="border-border/60 border-b pb-3 last:border-b-0 last:pb-0"
                  >
                    {rec.hasWaveform ? (
                      <button
                        type="button"
                        onClick={() => setSelectedId(rec.id)}
                        className="hover:bg-muted/40 -m-1 flex w-full items-start gap-3 rounded-md p-1 text-left transition-colors"
                      >
                        {rowInner}
                      </button>
                    ) : (
                      <div className="flex items-start gap-3">{rowInner}</div>
                    )}
                  </li>
                );
              })}
            </ol>

            {/* Load-bearing regulatory disclaimer — permanent,
              non-dismissible. Plain React text children (no markdown). */}
            <EcgDisclaimer />
          </>
        )}
      </InsightSectionCard>
    </section>
  );
}

/**
 * The detail view: waveform + metadata + device-attributed result +
 * permanent disclaimer + clinician note on a non-normal device result.
 * Exported so the non-diagnostic framing can be unit-tested directly.
 */
export function EcgDetail({
  recording,
  resultLabel,
  onBack,
}: {
  recording: EcgRecordingListItem;
  resultLabel: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data: detail, isLoading } = useQuery({
    queryKey: queryKeys.insightsEcgDetail(recording.id, false),
    queryFn: async () => {
      try {
        return await apiGet<EcgDetailResponse>(
          `/api/insights/ecg/${recording.id}`,
        );
      } catch {
        throw new Error(t("insights.ecg.loadError"));
      }
    },
  });

  const nonNormal = isNonNormal(recording.classification);
  const leadLabel = recording.lead ?? t("insights.ecg.meta.leadSingle");
  const durationLabel =
    recording.durationSeconds != null
      ? t("insights.ecg.meta.durationValue", {
          seconds: Math.round(recording.durationSeconds),
        })
      : t("insights.ecg.meta.unknown");

  return (
    <div data-slot="ecg-detail" className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground -ml-1 flex items-center gap-1 text-sm transition-colors"
      >
        <ChevronLeft className="size-4" />
        {t("insights.ecg.backToList")}
      </button>

      {/* The DEVICE's result, attributed to the device. This is the ONLY
        verdict shown — HealthLog produces none. */}
      {resultLabel && (
        <p
          data-slot="ecg-result"
          className="text-foreground text-sm font-medium"
        >
          {t("insights.ecg.resultAttribution", { result: resultLabel })}
        </p>
      )}

      {isLoading || !detail ? (
        <div
          data-slot="ecg-waveform-skeleton"
          className="bg-muted/40 h-40 w-full animate-pulse rounded-lg motion-reduce:animate-none"
        />
      ) : (
        <EcgWaveform
          samples={detail.samples}
          recordedAt={detail.recordedAt}
          durationSeconds={detail.durationSeconds}
          averageHeartRate={detail.averageHeartRate}
          resultLabel={resultLabel}
        />
      )}

      <dl
        data-slot="ecg-meta"
        className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3"
      >
        <MetaItem
          label={t("insights.ecg.meta.recorded")}
          value={fmt.dateTime(new Date(recording.recordedAt))}
        />
        <MetaItem
          label={t("insights.ecg.meta.duration")}
          value={durationLabel}
        />
        <MetaItem label={t("insights.ecg.meta.lead")} value={leadLabel} />
        <MetaItem
          label={t("insights.ecg.meta.averageHeartRate")}
          value={
            recording.averageHeartRate != null
              ? t("insights.ecg.meta.bpmValue", {
                  bpm: recording.averageHeartRate,
                })
              : t("insights.ecg.meta.unknown")
          }
        />
        <MetaItem
          label={t("insights.ecg.meta.samplingRate")}
          value={
            recording.samplingFrequency > 0
              ? t("insights.ecg.meta.hzValue", {
                  hz: recording.samplingFrequency,
                })
              : t("insights.ecg.meta.unknown")
          }
        />
      </dl>

      {/* "Discuss with a clinician" — only on a non-normal device result. */}
      {nonNormal && (
        <p
          data-slot="ecg-clinician-note"
          className="text-foreground text-sm font-medium"
        >
          {t("insights.ecg.clinicianNote")}
        </p>
      )}

      <EcgDisclaimer />
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The permanent, non-dismissible non-diagnostic disclaimer. States that the
 * displayed result is the device's and that HealthLog does not read,
 * interpret, or diagnose ECG recordings.
 */
function EcgDisclaimer() {
  const { t } = useTranslations();
  return (
    <div
      data-slot="ecg-disclaimer"
      role="note"
      className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg p-3 text-xs"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{t("insights.ecg.disclaimer")}</p>
    </div>
  );
}
