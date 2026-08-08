"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17.1 (N-5) — the up-affordance for a hub child editor.
 *
 * The four Layout personalization editors (dashboard / insights /
 * medications / mood) are reached through the "Layout & Personalization"
 * hub (or a page-header cog), and the left rail highlights the hub while
 * the body shows the child. The return path existed only implicitly (tap
 * the highlighted rail entry); this is the explicit "← back to hub" link
 * at the top of the child, so the hub → child → hub loop reads clearly,
 * especially on mobile where the rail collapses to a chip strip.
 */
export function SettingsHubBackLink({
  href,
  labelKey,
}: {
  href: string;
  labelKey: string;
}) {
  const { t } = useTranslations();
  return (
    <Link
      href={href}
      data-slot="settings-hub-back-link"
      className={cn(
        "text-muted-foreground hover:text-foreground -mx-1 inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium transition-colors",
      )}
    >
      <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(labelKey)}
    </Link>
  );
}
