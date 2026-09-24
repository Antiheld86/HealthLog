"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";
import { isSurfaceVisible, type StaticSurfaceId } from "@/lib/modules/surface";

/**
 * Whether a surface shows for the record this session is on, read through the
 * one surface map (`src/lib/modules/surface.ts`) against the resolved
 * `modules` of `GET /api/auth/me`.
 *
 * SSR-safe the way `useModuleEnabled` is: a presentational component rendered
 * without a `QueryClientProvider` gets the default-on answer instead of a
 * crash. The branch is stable for a component's lifetime, so the conditional
 * hook call is safe.
 *
 * Default-on: before the account resolves, and for every surface no module
 * owns, the answer is `true`. A caller whose first paint must match the server
 * render (nav lists, anything behind a hydration gate) keeps its own mounted
 * check on top.
 */
export function useSurfaceVisible(
  surfaceId: StaticSurfaceId | (string & {}),
): boolean {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return true;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSurfaceVisibleInner(surfaceId);
}

function useSurfaceVisibleInner(surfaceId: string): boolean {
  const { user } = useAuth();
  return isSurfaceVisible(surfaceId, user?.modules);
}
