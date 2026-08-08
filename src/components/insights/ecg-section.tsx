"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, HeartPulse } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  ecgResultLabel,
  type EcgClassification,
} from "@/lib/insights/ecg-classification";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.28.50 — ECG recording list.
 *
 * The user's ECG recordings synced from a single-lead device (Withings
 * ScanWatch today): one row per strip, each opening `/insights/ecg/<id>`
 * with the trace, the metadata and the DEVICE's own classification.
 *
 * NON-DIAGNOSTIC: the surface shows the waveform (raw data), the metadata
 * and the recording device's own result, attributed to the device on the
 * detail page. HealthLog generates NO interpretation of the waveform — no
 * measured intervals, no beat/P/QRS/T annotation, no risk score, no verdict
 * of its own. All copy renders as plain React text children (no markdown
 * library — the standing XSS rule).
 *
 * The list is capped: a device that records every morning accumulates
 * hundreds of strips, and a page that paints all of them is a scroll, not a
 * history. The most recent handful is what the surface is for.
 *
 * Data-availability-gated: the section un-mounts entirely (`return null`)
 * when the user has no recordings — never an empty / alarming card.
 */

/**
 * How many strips the list paints. The API already caps its own read at 200;
 * this is the reading limit, not the fetch limit.
 */
export const ECG_LIST_LIMIT = 5;

export interface EcgRecordingListItem {
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

interface EcgSectionProps {
  enabled?: boolean;
  className?: string;
  /**
   * v1.30 — suppress the internal `<SectionHeading>` when the section is
   * hosted on the routed `/insights/ecg` sub-page, whose `<SubPageShell>`
   * already renders the page `<h1>`. Defaults to `false` so the overview
   * teaser keeps its own heading unchanged.
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

  // The route hands them back most-recent-first; the slice is the reading
  // limit on top of that, so the newest strips are the ones on screen.
  const recordings = data.recordings.slice(0, ECG_LIST_LIMIT);

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
        <ol data-slot="ecg-list" className="space-y-3">
          {recordings.map((rec) => {
            const label = ecgResultLabel(rec.classification, t);
            const rowInner = (
              <>
                <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
                  <HeartPulse className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  {/* The device's verdict rides the timestamp as a tag
                      rather than claiming a line of its own — it qualifies
                      the recording, it is not a second fact about it. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-foreground text-sm font-medium">
                      {fmt.dateTime(new Date(rec.recordedAt))}
                    </p>
                    {label && (
                      <span
                        data-slot="ecg-row-result"
                        className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
                      >
                        {label}
                      </span>
                    )}
                  </div>
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
                  <Link
                    href={`/insights/ecg/${rec.id}`}
                    className="hover:bg-muted/40 -m-1 flex w-full items-start gap-3 rounded-md p-1 text-left transition-colors"
                  >
                    {rowInner}
                    <ChevronRight
                      className="text-muted-foreground mt-1.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </Link>
                ) : (
                  <div className="flex items-start gap-3">{rowInner}</div>
                )}
              </li>
            );
          })}
        </ol>
      </InsightSectionCard>
    </section>
  );
}
