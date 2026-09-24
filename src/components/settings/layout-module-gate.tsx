"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * v1.25.11 (#148) — client gate for an Appearance subpage
 * (`/settings/layout/<module>`).
 *
 * A module's subpage may be reached by direct URL even when the user has the
 * module turned off. This wrapper fails OPEN: it renders the section unless the
 * resolved `useAuth().user.modules` map has the gate key explicitly `false`,
 * in which case it bounces back to the hub (`/settings/layout`).
 *
 * The gate is hydration-stable: `useMounted()` returns `false` during SSR AND
 * the first client paint, so the first render ALWAYS shows the section
 * (matching the server HTML); the real check applies once, after hydration, as
 * an ordinary client update. The redirect is a client-only effect, so it never
 * diverges the initial render and cannot trigger a React #418 mismatch.
 *
 * Groups the surface map gives no owner (dashboard / insights / vorsorge)
 * pass `moduleKey={undefined}` and always render.
 */
export function LayoutModuleGate({
  moduleKey,
  children,
}: {
  moduleKey?: ModuleKey;
  children: React.ReactNode;
}) {
  const hydrated = useMounted();
  const { user } = useAuth();
  const router = useRouter();

  const disabled =
    hydrated && moduleKey !== undefined && user?.modules?.[moduleKey] === false;

  React.useEffect(() => {
    if (disabled) {
      router.replace("/settings/layout");
    }
  }, [disabled, router]);

  if (disabled) return null;
  return <>{children}</>;
}
