import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

/**
 * v1.30.x — the `/insights` server-prefetch key crux + fail-soft.
 *
 * The RSC wrapper (`src/app/insights/page.tsx`) dehydrates the dashboard
 * snapshot under the SAME locale-keyed cell the dashboard warms, so the
 * Insights hero's snapshot-derived band paints from the first HTML.
 *
 * THE CRUX: the snapshot cell is locale-keyed. The locale is resolved ONCE
 * server-side by `readDashboardSnapshotCached` and returned; the client keys on
 * the SAME resolved locale from the i18n context. These tests pin that the
 * server dehydrates under `queryKeys.dashboardSnapshot(<returned locale>)`
 * (byte-identical hash) + the widget layout, and that every error path fails
 * soft to the bare client.
 */

const getUnswitchedSession = vi.fn();
const readDashboardSnapshotCached = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: (u: unknown) => readDashboardSnapshotCached(u),
}));
vi.mock("../page-client", () => ({ default: () => null }));

import InsightsPage from "../page";

const SESSION = { user: { id: "u1", timezone: "Europe/Berlin" } };

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

function queriesOf(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } }[] {
  if (el.type !== HydrationBoundary) return [];
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  return props.state?.queries ?? [];
}

describe("/insights RSC prefetch", () => {
  it("dehydrates the snapshot under the locale-keyed client key", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    readDashboardSnapshotCached.mockResolvedValue({
      body: {
        healthScore: { tension: "steady" },
        layout: { version: 1, widgets: [] },
      },
      locale: "de",
    });

    const el = (await InsightsPage()) as ReactElement;
    const queries = queriesOf(el);
    const hashes = queries.map((q) => q.queryHash);
    // The client's `useDashboardSnapshot` keys on the SAME resolved locale.
    expect(hashes).toContain(hashKey(queryKeys.dashboardSnapshot("de")));
    // And the widget layout the snapshot carries is seeded too.
    expect(hashes).toContain(hashKey(queryKeys.dashboardWidgets()));
    // A zero-arg / wrong-locale key must NOT be what was seeded.
    expect(hashes).not.toContain(hashKey(queryKeys.dashboardSnapshot()));
    expect(hashes).not.toContain(hashKey(queryKeys.dashboardSnapshot("en")));
  });

  it("JSON-round-trips the snapshot body to the wire shape", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    const cachedAt = new Date("2026-07-18T06:00:00.000Z");
    readDashboardSnapshotCached.mockResolvedValue({
      body: { cachedAt, layout: { version: 1, widgets: [] } },
      locale: "en",
    });

    const el = (await InsightsPage()) as ReactElement;
    const snap = queriesOf(el).find(
      (q) => q.queryHash === hashKey(queryKeys.dashboardSnapshot("en")),
    );
    expect((snap!.state.data as { cachedAt: unknown }).cachedAt).toBe(
      cachedAt.toISOString(),
    );
  });

  it("fails soft to the bare client when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    readDashboardSnapshotCached.mockRejectedValue(new Error("db blip"));

    const el = (await InsightsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await InsightsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readDashboardSnapshotCached).not.toHaveBeenCalled();
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await InsightsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});
