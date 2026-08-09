"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  FileUp,
  PlusCircle,
  Plug,
  Settings2,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { MedicalDisclaimer } from "@/components/common/medical-disclaimer";
import { SampleBriefingCard } from "@/components/onboarding/sample-briefing-card";
import { useAuth } from "@/hooks/use-auth";
import { setTourReferrer } from "@/components/onboarding/tour-launcher";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

interface AiProviderStatus {
  /** Origin of the provider that would serve this user, if any. */
  managedBy?: "user" | "local" | "server" | null;
}

/**
 * v1.4.25 W14b-Content — onboarding step 4 (done).
 *
 * Confirms the user has finished onboarding. `onboardingCompletedAt`
 * was flipped server-side by the baseline form's `POST step:4` write,
 * so this page is purely presentational — no further mutation, no
 * cookie flips, no API calls.
 *
 * The single CTA returns the user to the dashboard. The link goes
 * through `next/link` so the regular client-side navigation kicks in
 * (the proxy redirect was cleared with the same step-API write that
 * landed the user here).
 *
 * v1.18.6 — on mount we write the per-user wizard-return marker so the
 * shell-level `<TourLauncher>` auto-opens the module tour immediately
 * on the next dashboard arrival (sequenced after the post-wizard
 * grace), instead of waiting out the 24 h fallback. Whichever exit the
 * user picks from this screen, the next `/` mount finds the marker.
 */

export function DoneScreen() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const [sampleOpen, setSampleOpen] = useState(false);

  useEffect(() => {
    if (user?.id) setTourReferrer(user.id);
  }, [user?.id]);

  // The shared-key note is the ONLY honest divergence in the panel: on a
  // deployment that ships an operator key, insights already work for the
  // user, so we say so plainly instead of pushing a BYOK/local setup they
  // don't need. Presence-only read; no key material is exposed.
  const { data: aiProvider } = useQuery<AiProviderStatus>({
    queryKey: queryKeys.userAiProvider(),
    queryFn: async () => {
      return apiGet("/api/user/ai-provider");
    },
    enabled: !!user,
  });
  const sharedKeyServes = aiProvider?.managedBy === "server";

  return (
    <section
      aria-labelledby="onboarding-done-title"
      className="flex flex-col items-center gap-6 py-6 text-center"
    >
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full"
      >
        <CheckCircle2 className="size-10" />
      </span>

      <header className="space-y-2">
        {/* Onboarding hero H1: intentionally semibold, not the app-wide bold PageHeader H1 (UI-STANDARDS §5 hero exception). Do not sweep to font-bold. */}
        <h1
          id="onboarding-done-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.done.title")}
        </h1>
        <p className="text-muted-foreground mx-auto max-w-md text-base leading-relaxed">
          {t("onboarding.done.body")}
        </p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm leading-relaxed">
          {t("onboarding.done.learning")}
        </p>
      </header>

      {/* v1.28 — the flagship AI value, made reachable at the one screen
          every fresh user passes through. The daily briefing / Coach need
          a provider the rest of onboarding never provisions, so this
          leads with the payoff (a static, clearly-labelled SAMPLE
          briefing — no model call, no egress, no consent), then the
          honest local-first ladder and the "useful without AI" release
          valve. Value-first, never a gate: the three exits below stay,
          and setup is a single optional deep-link. */}
      <section
        aria-labelledby="onboarding-ai-panel-title"
        data-slot="onboarding-ai-panel"
        className="border-border bg-card mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl border p-4 text-left md:p-6"
      >
        <header className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="from-primary to-brand-pink flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
          >
            <Sparkles className="text-background size-4" />
          </span>
          <div className="space-y-1">
            <h2
              id="onboarding-ai-panel-title"
              className="text-foreground text-base font-semibold tracking-tight"
            >
              {t("onboarding.ai.panelTitle")}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("onboarding.ai.panelIntro")}
            </p>
          </div>
        </header>

        {sampleOpen ? (
          <SampleBriefingCard />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            data-slot="onboarding-ai-show-sample"
            onClick={() => setSampleOpen(true)}
          >
            {t("onboarding.ai.showSample")}
          </Button>
        )}

        {sharedKeyServes ? (
          <p
            data-slot="onboarding-ai-shared-key"
            className="text-foreground bg-primary/5 border-primary/20 rounded-lg border px-3 py-2 text-sm leading-relaxed"
          >
            {t("onboarding.ai.sharedKeyNote")}
          </p>
        ) : null}

        <div className="space-y-2.5">
          <p className="text-foreground text-sm font-medium">
            {t("onboarding.ai.ladderTitle")}
          </p>
          <ul className="space-y-2.5">
            {/* Local first — the calm, private default — then BYOK, then
                the subscription/OAuth path with its training caveat. Same
                ordering + vendor-blind framing as the shipped document-
                provider governance. */}
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderLocalTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderLocalBody")}
              </p>
            </li>
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderByokTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderByokBody")}
              </p>
            </li>
            <li className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t("onboarding.ai.ladderOauthTitle")}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("onboarding.ai.ladderOauthBody")}
              </p>
            </li>
          </ul>
        </div>

        <p
          data-slot="onboarding-ai-keyless"
          className="text-foreground text-sm leading-relaxed"
        >
          {t("onboarding.ai.keylessLine")}
        </p>

        <MedicalDisclaimer variant="dataPosture" />

        <Link
          href="/settings/ai"
          className="text-primary text-sm font-medium underline-offset-4 hover:underline"
        >
          {t("onboarding.ai.setupCta")}
        </Link>
      </section>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button asChild size="lg">
          <Link
            href="/settings/integrations"
            className="inline-flex items-center gap-2"
          >
            <Plug className="size-4" />
            {t("onboarding.done.connectCta")}
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/measurements" className="inline-flex items-center gap-2">
            <PlusCircle className="size-4" />
            {t("onboarding.done.logCta")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">{t("onboarding.done.returnCta")}</Link>
        </Button>
      </div>

      {/* 2026-07-17 UX-onboarding audit M5 — the module system (default-on
          set + opt-ins like nutrients / mental health / documents) is
          otherwise undiscoverable during first-run: the wizard never
          mentions it, and the only pointer used to be one tour stop.
          A quiet link here, beside the existing import link, gives every
          new account one honest pointer to Settings → Modules before they
          leave the wizard. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        <Link
          href="/settings/export"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
        >
          <FileUp className="size-3.5" />
          {t("onboarding.done.importCta")}
        </Link>
        <Link
          href="/settings/modules"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
        >
          <Settings2 className="size-3.5" />
          {t("onboarding.done.modulesCta")}
        </Link>
      </div>
    </section>
  );
}
