"use client";

/**
 * v1.39.4 — the tables under an assistant reply. A live turn hands its
 * tables in from the `result` frames; a persisted message lists only their
 * metadata, and the values are fetched when the message scrolls into view
 * (`useCoachMessageResults`). A withheld table is skipped here; the notice
 * for it belongs to the table view.
 *
 * The bubble renders this twice: the tables the answer referenced
 * (`section="displayed"`) expanded under the prose, and the rest
 * (`section="dataUsed"`) under "Data used (n)" inside the evidence
 * disclosure. Both instances share one cached read.
 *
 * A table with a chart gets a chart/table toggle. The chart is the first
 * view for a referenced table; a table under "Data used" opens as a table.
 * The choice is local to this render and never stored. The chart sits in a
 * figure; its plot is one `role="img"` whose name points at the table view
 * for every value.
 */
import { useId, useState } from "react";
import dynamic from "next/dynamic";
import { ChartLine, Table2 } from "lucide-react";

import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { ViewToggle } from "@/components/ui/view-toggle";
import { useCoachMessageResults } from "@/hooks/use-coach-message-results";
import { COACH_RESULT_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import type {
  CoachResultMeta,
  CoachResultTable as CoachResultTableData,
} from "@/lib/ai/coach/types";
import { useTranslations } from "@/lib/i18n/context";
import { importWithRetry } from "@/lib/retry-import";

import { CoachResultTable } from "./result-table";

const CoachResultChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.CoachResultChart }),
    ),
  {
    ssr: false,
    loading: () => (
      <ChartSkeleton mini className="border-0 bg-transparent p-0" />
    ),
  },
);

export type CoachResultsSection = "displayed" | "dataUsed";

export interface CoachResultsProps {
  conversationId: string | null;
  /** The persisted message, once it has an id. */
  messageId: string | null;
  /** `metricSource.results` of the message. */
  metas: CoachResultMeta[];
  /** The tables a live turn streamed; absent on a persisted message. */
  live?: CoachResultTableData[];
  /** Which of the message's tables this instance shows. */
  section: CoachResultsSection;
}

/** How many tables sit in a section, from the metadata alone. */
export function countResultsInSection(
  metas: ReadonlyArray<Pick<CoachResultMeta, "displayed">>,
  section: CoachResultsSection,
): number {
  return metas.filter((meta) =>
    section === "displayed" ? meta.displayed : !meta.displayed,
  ).length;
}

export function CoachResults({
  conversationId,
  messageId,
  metas,
  live,
  section,
}: CoachResultsProps) {
  const { t } = useTranslations();
  const hasLive = (live?.length ?? 0) > 0;
  const expected = hasLive
    ? countResultsInSection(live ?? [], section)
    : countResultsInSection(metas, section);
  const { ref, results } = useCoachMessageResults({
    conversationId,
    messageId,
    enabled: !hasLive && expected > 0,
  });
  if (expected === 0) return null;
  const tables: CoachResultTableData[] = (
    hasLive
      ? (live ?? [])
      : (results ?? []).filter(
          (entry): entry is CoachResultTableData => !("withheld" in entry),
        )
  ).filter((table) =>
    section === "displayed" ? table.displayed : !table.displayed,
  );

  const list = (
    <div
      ref={section === "displayed" ? ref : undefined}
      data-slot="coach-results"
      data-section={section}
      className="flex flex-col gap-3"
    >
      {tables.map((table) => (
        <CoachResultView
          key={table.ref}
          result={table}
          chartFirst={section === "displayed"}
        />
      ))}
    </div>
  );
  if (section === "displayed") return list;
  return (
    <div ref={ref} data-slot="coach-data-used" className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs font-medium">
        {t(COACH_RESULT_UI_KEYS.dataUsed, { count: expected })}
      </p>
      {list}
    </div>
  );
}

type ResultView = "chart" | "table";

function CoachResultView({
  result,
  chartFirst,
}: {
  result: CoachResultTableData;
  chartFirst: boolean;
}) {
  const { t } = useTranslations();
  const titleId = useId();
  const hasChart = result.chart !== null;
  const [view, setView] = useState<ResultView>(
    hasChart && chartFirst ? "chart" : "table",
  );
  if (!hasChart) return <CoachResultTable result={result} />;

  const toggle = (
    <ViewToggle<ResultView>
      view={view}
      onChange={setView}
      groupLabel={t(COACH_RESULT_UI_KEYS.viewLabel)}
      dataSlotPrefix="coach-result-view"
      segments={[
        {
          value: "chart",
          label: t(COACH_RESULT_UI_KEYS.viewChart),
          icon: ChartLine,
        },
        {
          value: "table",
          label: t(COACH_RESULT_UI_KEYS.viewTable),
          icon: Table2,
        },
      ]}
    />
  );
  if (view === "table") {
    return <CoachResultTable result={result} toolbar={toggle} />;
  }
  return (
    <figure
      data-slot="coach-result-chart"
      data-ref={result.ref}
      data-chart-kind={result.chart?.kind}
      aria-labelledby={titleId}
      className="bg-card m-0 flex flex-col gap-2 rounded-lg border px-3 pt-2 pb-3"
    >
      <figcaption className="flex items-start justify-between gap-3">
        <span
          id={titleId}
          className="text-foreground min-w-0 flex-1 pt-1.5 text-sm font-medium"
        >
          {result.title}
        </span>
        <span className="shrink-0">{toggle}</span>
      </figcaption>
      <ChartErrorBoundary>
        <CoachResultChartLazy
          result={result}
          otherLabel={t(COACH_RESULT_UI_KEYS.other)}
          label={t(COACH_RESULT_UI_KEYS.chartSummary, {
            title: result.title,
          })}
        />
      </ChartErrorBoundary>
    </figure>
  );
}
