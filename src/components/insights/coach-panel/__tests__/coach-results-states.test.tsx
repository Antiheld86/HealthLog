/**
 * v1.39.4 — what a persisted message's tables look like when not every one
 * can be shown: a withheld table leaves a meta line saying why, a failed
 * read leaves an error row with a retry, and the "Data used (n)" header
 * counts the tables it goes on to list. A table copied from an earlier
 * answer says so, with that answer's date. SSR harness with the lazy read
 * stubbed, like the other Coach panel tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  CoachResultEntry,
  CoachResultMeta,
  CoachResultTable as Table,
} from "@/lib/ai/coach/types";

const state: {
  results: CoachResultEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = {
  results: undefined,
  isLoading: false,
  isError: false,
  refetch: () => {},
};

vi.mock("@/hooks/use-coach-message-results", () => ({
  useCoachMessageResults: () => ({ ref: () => {}, ...state }),
}));

// The error row's own markup is the primitive's business; what matters here
// is which message and which retry it is handed.
const errorRow: {
  props: { message?: ReactNode; onRetry?: () => void } | null;
} = { props: null };
vi.mock("@/components/ui/query-error-row", () => ({
  QueryErrorRow: (props: {
    message?: ReactNode;
    onRetry?: () => void;
    slot?: string;
    retrySlot?: string;
  }) => {
    errorRow.props = props;
    return (
      <div data-slot={props.slot} role="alert">
        {props.message}
        <button type="button" data-slot={props.retrySlot}>
          Retry
        </button>
      </div>
    );
  },
}));

import { I18nProvider } from "@/lib/i18n/context";

import { CoachMessageDatesProvider, CoachResults } from "../coach-results";

function table(overrides: Partial<Table> = {}): Table {
  return {
    ref: "r1",
    source: {
      tool: "get_metric_table",
      domain: "bp",
      window: "last30days",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "Blood pressure by day",
    rowCount: 1,
    chartKind: null,
    displayed: true,
    columns: [
      {
        key: "day",
        kind: "period",
        labelKey: "coach.result.column.day",
        label: "Day",
      },
      {
        key: "systolic",
        kind: "number",
        labelKey: "coach.result.column.systolic",
        label: "Systolic",
        unit: "mmHg",
        decimals: 0,
      },
    ],
    rows: [["2026-09-01", 124]],
    truncated: false,
    chart: null,
    ...overrides,
  };
}

function meta(table: Table): CoachResultMeta {
  const { columns: _c, rows: _r, truncated: _t, chart: _ch, ...rest } = table;
  return rest;
}

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function persisted(
  metas: CoachResultMeta[],
  section: "displayed" | "dataUsed",
) {
  return render(
    <CoachResults
      conversationId="c1"
      messageId="m2"
      metas={metas}
      section={section}
    />,
  );
}

beforeEach(() => {
  state.results = undefined;
  state.isLoading = false;
  state.isError = false;
  state.refetch = () => {};
  errorRow.props = null;
});

describe("CoachResults on a persisted message", () => {
  it("says why a withheld table is missing, one line per table", () => {
    const shown = table({ ref: "r1", displayed: false });
    const off = table({ ref: "r2", displayed: false });
    const lost = table({ ref: "r3", displayed: false });
    state.results = [
      shown,
      { ref: "r2", withheld: "module_disabled" },
      { ref: "r3", withheld: "unavailable" },
    ];
    const html = persisted([meta(shown), meta(off), meta(lost)], "dataUsed");
    expect(html).toContain("Data used (3)");
    expect(html).toContain('data-ref="r1"');
    expect(html.match(/data-slot="coach-result-withheld"/g)).toHaveLength(2);
    expect(html).toContain(
      "This table is hidden because its module is switched off.",
    );
    expect(html).toContain("This table couldn&#x27;t be loaded.");
    expect(html).toMatch(
      /data-slot="coach-result-withheld"[^>]*class="[^"]*text-muted-foreground/,
    );
  });

  it("counts only the tables it shows or explains in the header", () => {
    const one = table({ ref: "r1", displayed: false });
    const two = table({ ref: "r2", displayed: false });
    // The read returned r1 and nothing for r2: r2 is explained, not dropped.
    state.results = [one];
    const html = persisted([meta(one), meta(two)], "dataUsed");
    expect(html).toContain("Data used (2)");
    expect(html.match(/data-slot="coach-result-withheld"/g)).toHaveLength(1);
  });

  it("shows a failed read as an error row with a retry", () => {
    state.isError = true;
    const refetch = vi.fn();
    state.refetch = refetch;
    const html = persisted([meta(table())], "displayed");
    expect(html).toContain('data-slot="coach-results-error"');
    expect(html).toContain("Couldn&#x27;t load the tables.");
    expect(html).toContain('data-slot="coach-results-retry"');
  });

  it("wires the retry to a new read", () => {
    state.isError = true;
    const refetch = vi.fn();
    state.refetch = refetch;
    persisted([meta(table())], "displayed");
    errorRow.props?.onRetry?.();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("a table from an earlier answer", () => {
  it("carries a meta line naming that answer's date", () => {
    const reused = table({ reusedFrom: { messageId: "m1", ref: "r1" } });
    state.results = [reused];
    const html = render(
      <CoachMessageDatesProvider
        dates={new Map([["m1", "2026-09-03T10:00:00.000Z"]])}
      >
        <CoachResults
          conversationId="c1"
          messageId="m2"
          metas={[meta(reused)]}
          section="displayed"
        />
      </CoachMessageDatesProvider>,
    );
    expect(html).toMatch(
      /class="text-muted-foreground text-xs">From an earlier answer \([^)]*\b0?3\b[^)]*\)</,
    );
  });

  it("says so without a date when the earlier message is not at hand", () => {
    const reused = table({ reusedFrom: { messageId: "gone", ref: "r1" } });
    state.results = [reused];
    const html = persisted([meta(reused)], "displayed");
    expect(html).toContain(">From an earlier answer<");
  });

  it("puts the line under the chart title too", () => {
    const reused = table({
      reusedFrom: { messageId: "m1", ref: "r1" },
      chart: { kind: "line", x: "day", series: ["systolic"] },
      chartKind: "line",
    });
    const html = render(
      <CoachResults
        conversationId="c1"
        messageId="m2"
        metas={[]}
        live={[reused]}
        section="displayed"
      />,
    );
    expect(html).toMatch(
      /<figcaption[\s\S]*From an earlier answer[\s\S]*<\/figcaption>/,
    );
    expect(html).toMatch(/<figure[^>]*class="[^"]*\bw-full\b/);
  });

  it("shows no such line on a fresh table", () => {
    state.results = [table()];
    const html = persisted([meta(table())], "displayed");
    expect(html).not.toContain("From an earlier answer");
  });
});
