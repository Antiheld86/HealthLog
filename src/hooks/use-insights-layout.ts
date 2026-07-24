"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import {
  DEFAULT_INSIGHTS_LAYOUT,
  resolveInsightsLayout,
  type InsightsLayoutWithToken,
} from "@/lib/insights-layout";

/**
 * v1.15.11 — the resolved insights overview layout (sections + tiles) plus the
 * query load status.
 *
 * Reads `GET /api/insights/layout` through the centralised query-key factory
 * (`queryKeys.insightsLayout()` → `["user","insightsLayout"]`), the same key
 * the inline-edit PUT mutation invalidates on save so the overview repaints in
 * lockstep with the edit surface. The response is already the server-resolved
 * v2 layout; we pass it back through `resolveInsightsLayout` defensively so a
 * partial / legacy blob from a stale cache still normalises to a valid
 * `InsightsLayout`.
 *
 * Returns `DEFAULT_INSIGHTS_LAYOUT` while the query is in-flight so the page
 * renders in the default section + tile order on first paint — no layout
 * flicker, no empty state, no "everything hidden" flash before the saved
 * layout lands.
 *
 * `isLoading` lets a caller gate a write surface (the inline "Anpassen" edit
 * mode) until the GET has settled: without that gate a user who enters edit
 * mode while the layout is still in-flight would seed the editor from
 * `DEFAULT_INSIGHTS_LAYOUT` and a "Fertig" save would PUT defaults over their
 * real saved layout.
 *
 * v1.32.21 (R5a, B-3) — the resolver rebuilds a FIXED `InsightsLayout` shape
 * and would DROP the server's `updatedAt` optimistic-concurrency token. If it
 * did, every insights-layout write would fall back to the server's compat
 * (unconditional) arm and the #581-class guard would be dead on arrival. So we
 * re-attach the token AFTER normalising: the query cache holds an
 * `InsightsLayoutWithToken`, and the two writers (`insights-edit-mode`,
 * `insights-pill-order-section`) echo it via `readUpdatedAtToken`. Mirrors the
 * dashboard B-3 fix that kept the token available through its own seed path.
 */
export function useInsightsLayoutQuery(enabled: boolean): {
  layout: InsightsLayoutWithToken;
  isLoading: boolean;
  isSuccess: boolean;
} {
  const { data, isLoading, isSuccess } = useQuery({
    queryKey: queryKeys.insightsLayout(),
    queryFn: async () => {
      const raw = await apiGet<InsightsLayoutWithToken>("/api/insights/layout");
      return {
        ...resolveInsightsLayout(raw),
        updatedAt: raw?.updatedAt,
      } satisfies InsightsLayoutWithToken;
    },
    enabled,
  });
  return {
    layout: data ?? DEFAULT_INSIGHTS_LAYOUT,
    // `enabled: false` keeps the query in a pending-but-idle state; treat a
    // disabled (unauthenticated) query as not-loading so the gate never sticks.
    isLoading: enabled && isLoading,
    isSuccess,
  };
}
