"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * v1.18.0 R4 — SSR-safe accessor for a per-account module flag.
 *
 * `useAuth()` calls `useQuery` directly and
 * crashes when a legacy presentational component (`<HeroStrip>`, the
 * isolated score-card snapshots, …) renders without a
 * `<QueryClientProvider>`. We gate the inner hook on
 * `useQueryClientMounted()` and short-circuit to the default-on result
 * when no client is in the tree — the branch is stable across the
 * component's lifetime, so the conditional call is safe per the Rules of
 * Hooks.
 *
 * Default-on (disabled allowlist): an absent map, a missing key, or any
 * non-`false` value reads as enabled — matching the server gate in
 * `src/lib/modules/gate.ts`.
 */
export function useModuleEnabled(moduleKey: ModuleKey): boolean {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return true;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useModuleEnabledInner(moduleKey);
}

function useModuleEnabledInner(moduleKey: ModuleKey): boolean {
  const { user } = useAuth();
  return user?.modules?.[moduleKey] !== false;
}
