"use client";

import { FlaskConical } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Slim persistent banner shown while the instance runs with
 * `DEMO_MODE=true`. The proxy already blocks every mutation outside a
 * small allowlist (`src/proxy.ts`), but pre-banner the only feedback a
 * demo visitor got was an English API error after submitting a form.
 * This strip tells the visitor up front that nothing they change will
 * persist.
 *
 * Mount strategy mirrors `<OfflineBanner>`: rendered once inside
 * `<AuthShell>` so every routed page inherits it. The flag itself is a
 * server-only env var, so the root layout (a server component) reads
 * `process.env.DEMO_MODE` and threads the boolean through the
 * `demoMode` prop on `<AuthShell>` — no client-side detection, no
 * extra request.
 *
 * Copy lives in `messages/*.json` under `demoBanner.message`; all six
 * locales ship together.
 */
export function DemoBanner() {
  const { t } = useTranslations();

  return (
    <div
      role="status"
      data-slot="demo-banner"
      className="bg-primary/10 border-primary/30 text-foreground flex items-center justify-center gap-2 border-b px-3 py-2 text-xs"
    >
      <FlaskConical className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-center">{t("demoBanner.message")}</span>
    </div>
  );
}
