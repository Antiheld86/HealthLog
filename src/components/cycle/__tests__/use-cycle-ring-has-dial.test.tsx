/**
 * The scores strip gives the cycle ring a cell only when the ring would draw
 * a dial. The ring renders nothing without an active cycle, and a cell
 * reserved for it (with Strain dropped to make room) sat empty in the row.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";

import { localYmd, useCycleRingHasDial } from "../use-cycle";

function window(): [string, string] {
  const from = new Date();
  from.setDate(from.getDate() - 90);
  const to = new Date();
  to.setDate(to.getDate() + 180);
  return [localYmd(from), localYmd(to)];
}

function Probe({ enabled }: { enabled: boolean }) {
  return <span>{String(useCycleRingHasDial(enabled))}</span>;
}

function hasDial(verdict: unknown, enabled = true): boolean {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: 0 } },
  });
  const [from, to] = window();
  client.setQueryData(queryKeys.cycleCalendar(from, to), { verdict });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
  return html === "<span>true</span>";
}

describe("useCycleRingHasDial", () => {
  it("is true while a cycle is active today", () => {
    expect(hasDial({ phase: "follicular", dayOfCycle: 6 })).toBe(true);
  });

  it("is false without an active cycle, so no empty cell is reserved", () => {
    expect(hasDial({ phase: null, dayOfCycle: null })).toBe(false);
    expect(hasDial(null)).toBe(false);
  });

  it("is false while the cycle surface is hidden", () => {
    expect(hasDial({ phase: "luteal", dayOfCycle: 20 }, false)).toBe(false);
  });
});
