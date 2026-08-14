"use client";

/**
 * Test-only harness that reproduces the page heading the live `SettingsShell`
 * paints for a given section slug (`settings-shell.tsx` headingBlock). The
 * per-section SSR smoke tests render a section body through this harness so
 * they can assert the visible heading + its historic `settings-section-<slug>-title`
 * id alongside the body — mirroring what a user sees on the route.
 *
 * Production no longer wraps section bodies in a standalone frame component:
 * the shell paints the heading from the slug and each section body is just its
 * cards. This harness lives in `__tests__` only and is never bundled.
 */

import * as React from "react";

import { useTranslations } from "@/lib/i18n/context";

export function SettingsSectionFrame({
  slug,
  children,
}: {
  /**
   * A section slug OR a layout-hub child id (`dashboard`, `mood`, …) — the
   * children left `SETTINGS_SECTION_SLUGS` in v1.37.19 but their heading
   * keys and section bodies live on under `/settings/layout/<module>`.
   */
  slug: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  const titleId = `settings-section-${slug}-title`;

  return (
    <section aria-labelledby={titleId} className="space-y-6">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 id={titleId} className="text-2xl font-bold tracking-tight">
            {t(`settings.sections.${slug}.title`)}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t(`settings.sections.${slug}.subtitle`)}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}
