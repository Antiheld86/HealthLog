/**
 * The scores strip gives the cycle ring a cell only when the ring would draw
 * a dial. The ring renders nothing without an active cycle, and a cell
 * reserved for it (with Strain dropped to make room) sat empty in the row.
 *
 * The decision waits on the calendar read, so the hook also says when it is
 * still pending: the strip holds its skeleton until then instead of painting
 * Strain and swapping it for the ring a moment later.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";

import { localYmd, useCycleRingDial } from "../use-cycle";

function window(): [string, string] {
  const from = new Date();
  from.setDate(from.getDate() - 90);
  const to = new Date();
  to.setDate(to.getDate() + 180);
  return [localYmd(from), localYmd(to)];
}

function Probe({ enabled }: { enabled: boolean }) {
  const { dial, pending } = useCycleRingDial(enabled);
  return <span>{`${dial}:${pending}`}</span>;
}

function probe(verdict: unknown | undefined, enabled = true): string {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: 0 } },
  });
  const [from, to] = window();
  if (verdict !== undefined) {
    client.setQueryData(queryKeys.cycleCalendar(from, to), { verdict });
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
  return html.replace(/<\/?span>/g, "");
}

describe("useCycleRingDial", () => {
  it("has a dial while a cycle is active today", () => {
    expect(probe({ phase: "follicular", dayOfCycle: 6 })).toBe("true:false");
  });

  it("has none without an active cycle, so no empty cell is reserved", () => {
    expect(probe({ phase: null, dayOfCycle: null })).toBe("false:false");
    expect(probe(null)).toBe("false:false");
  });

  it("has none, and is not pending, while the cycle surface is hidden", () => {
    expect(probe({ phase: "luteal", dayOfCycle: 20 }, false)).toBe(
      "false:false",
    );
    expect(probe(undefined, false)).toBe("false:false");
  });

  it("is pending until the calendar read lands", () => {
    expect(probe(undefined)).toBe("false:true");
  });
});

describe("the scores strip waits for the ring's decision", () => {
  it("holds its skeleton while the decision is pending", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/insights/page-client.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /isLoading=\{\s*dashboardDerived\.isLoading\s*\|\|\s*cycleRing\.pending\s*\}/,
    );
  });
});
