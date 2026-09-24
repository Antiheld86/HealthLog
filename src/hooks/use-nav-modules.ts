"use client";

import { useMemo } from "react";

import { useAiCapability } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import type { SurfaceModuleMap } from "@/lib/modules/surface";

/**
 * The module map the navigation filters by, with the Coach entry following
 * the `coach` AI capability.
 *
 * `modules.coach` answers the operator's switch and the person's Hide Coach,
 * but not a missing provider or missing consent, so on its own it would keep
 * a Coach entry in the nav that opens a Coach unable to answer. The
 * capability answers all of them, and every other Coach entry point (the
 * floating button, the launch buttons, the Coach pages) already reads it.
 * The sidebar and the bottom bar both take their map from here so the two
 * cannot disagree.
 */
export function useNavModules(): SurfaceModuleMap | undefined {
  const { user } = useAuth();
  const coach = useAiCapability("coach");
  const modules = user?.modules;
  return useMemo(
    () =>
      modules === undefined
        ? undefined
        : { ...modules, coach: modules.coach !== false && coach.available },
    [modules, coach.available],
  );
}
