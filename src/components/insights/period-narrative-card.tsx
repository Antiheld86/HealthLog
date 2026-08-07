"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange } from "lucide-react";

import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/ui/section-heading";
import { AskCoachIconButton } from "@/components/insights/ask-coach-action";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { apiGet } from "@/lib/api/api-fetch";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.11.0 W3 — period-narrative card (Pillar P1).
 *
 * A calm, top-of-overview summary of the user's last week / month, drawn from
 * the read-only `GET /api/insights/narrative` route. The route is
 * stale-while-revalidate: it returns the last good prose instantly and warms a
 * fresh one out of band, so this card never blocks on the provider.
 *
 * Restraint guarantees: plain React text children (NO markdown — the whole
 * tree forbids a markdown library for XSS reasons), no score, no chart, and a
 * single ⓘ provenance disclosure. The in-flight skeleton reserves a `min-h`
 * footprint so the first paint holds the row open (CLS-safe); the resolved card
 * then sizes to its content so a short narrative leaves no empty tail.
 */

type NarrativePeriod = "week" | "month";

interface NarrativeProvenance {
  metrics: string[];
  window: { from: string; to: string };
  pairsTested: number;
  fdrQ: number;
  computedAt: string;
}

interface NarrativeResponse {
  period: NarrativePeriod;
  locale: string;
  narrative: {
    text: string;
    provenance: NarrativeProvenance | null;
    updatedAt: string;
  } | null;
  revalidating: boolean;
}

interface PeriodNarrativeCardProps {
  /** Gate the underlying read (e.g. on the auth flag). */
  enabled?: boolean;
  className?: string;
}

async function fetchNarrative(
  period: NarrativePeriod,
): Promise<NarrativeResponse> {
  return apiGet<NarrativeResponse>(`/api/insights/narrative?period=${period}`);
}

// The in-flight skeleton keeps a `min-h` floor so the initial paint reserves the
// row (CLS-safe). The resolved card drops the floor and sizes to its content —
// a short narrative used to leave a large empty tail under the prose, widened by
// the footer's `mt-auto` pinning it to the bottom of the floored height.
const SKELETON_FLOOR = "border-border min-h-40";

export function PeriodNarrativeCard({
  enabled = true,
  className,
}: PeriodNarrativeCardProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  // Issue #490 — the SAME resolved zone `fmt.time` renders in (mirror →
  // Berlin), so the today/yesterday boundary and the clock can never split.
  const displayTz = useDisplayTimezone();
  const [period, setPeriod] = useState<NarrativePeriod>("week");

  const query = useQuery({
    queryKey: queryKeys.insightsNarrative(period, locale),
    queryFn: () => fetchNarrative(period),
    enabled,
    // The route warms out of band; poll briefly while a refresh is in flight
    // so freshly-warmed prose lands without a manual remount.
    refetchInterval: (q) =>
      q.state.data?.revalidating && !q.state.data.narrative ? 5000 : false,
  });

  // Loading with nothing to show yet → matched skeleton (CLS-safe). The
  // heading renders above the skeleton so the section reserves its full
  // height (heading + card) before the prose lands.
  if (query.isLoading) {
    return (
      <section
        data-slot="period-narrative-section"
        aria-label={t("insights.narrativeTitle")}
        className={cn("space-y-3", className)}
      >
        <SectionHeading
          icon={CalendarRange}
          title={t("insights.narrativeTitle")}
        />
        <InsightSectionCard
          slot="period-narrative-card-skeleton"
          aria-hidden="true"
          className={SKELETON_FLOOR}
        >
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </InsightSectionCard>
      </section>
    );
  }

  // The route never errors the page; on a fetch error or whenever there is no
  // real generated narrative yet (empty account, or a first warm still in
  // flight) the card un-mounts itself rather than showing an error, a
  // "preparing" husk, or the methodology framing. The query stays mounted and
  // polls in the background, so the card appears the moment a narrative lands.
  const narrative = query.data?.narrative ?? null;
  if (query.isError || !narrative) {
    return null;
  }

  return (
    <section
      data-slot="period-narrative-section"
      aria-label={t("insights.narrativeTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={CalendarRange}
        title={t("insights.narrativeTitle")}
      />
      <InsightSectionCard
        slot="period-narrative-card"
        data-period={period}
        className="border-border"
      >
        {/* Header row: week / month toggle on the left, the icon-only Coach
            hand-off pinned top-right. Matches the assessment cards, which carry
            the same single `<AskCoachIconButton>` in their header's right slot
            (no text label, tooltip + accessible name). The summary spans the
            whole picture for the window, so no scope: the default snapshot
            reads best. */}
        <div className="flex items-start justify-between gap-2">
          {/* Calm segmented control, no chart. */}
          <div className="flex gap-1">
            {(["week", "month"] as const).map((p) => {
              const active = period === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    "focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p === "week"
                    ? t("insights.narrativeWeek")
                    : t("insights.narrativeMonth")}
                </button>
              );
            })}
          </div>
          <AskCoachIconButton
            question={t(
              period === "week"
                ? "insights.coach.seed.periodWeek"
                : "insights.coach.seed.periodMonth",
            )}
            className="shrink-0"
          />
        </div>

        {/* v1.22 (W6) — real paragraphs via the shared ProseBlocks helper
            (still plain text children — NO markdown renderer, XSS posture). */}
        <div className="text-foreground text-sm">
          <ProseBlocks text={narrative.text} />
        </div>

        <p className="text-muted-foreground text-right text-xs">
          {query.data?.revalidating
            ? t("insights.narrativeUpdating")
            : formatUpdatedLabel(
                narrative.updatedAt,
                t,
                fmt.dateShort,
                fmt.time,
                displayTz,
              )}
        </p>
      </InsightSectionCard>
    </section>
  );
}
