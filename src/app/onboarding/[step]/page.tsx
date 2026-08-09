import { redirect, notFound } from "next/navigation";
import Link from "next/link";

import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { WelcomeCarousel } from "@/components/onboarding/welcome-carousel";
import { GoalsChipPicker } from "@/components/onboarding/goals-chip-picker";
import { SourceCardGrid } from "@/components/onboarding/source-card-grid";
import { BaselineForm } from "@/components/onboarding/baseline-form";
import { DoneScreen } from "@/components/onboarding/done-screen";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

/**
 * Onboarding wizard step page.
 *
 * Routes:
 *   /onboarding/0  welcome    → carousel / value-prop intro
 *   /onboarding/1  goals      → "what do you want to track?"
 *   /onboarding/2  source     → device/import source cards (see
 *                               source-card-grid.tsx for the shipped set)
 *   /onboarding/3  baseline   → first measurement or sync confirmation
 *   /onboarding/4  done       → success screen + return to dashboard
 *
 * Step gating:
 *   - Unauthenticated → `/auth/login` (the proxy also enforces this,
 *     but the server-side check keeps the contract explicit).
 *   - `onboardingCompletedAt != null` → `/` (no replaying the wizard
 *     by URL once the user has finished).
 *   - Out-of-order requests (e.g. user lands on `/onboarding/3` while
 *     `onboardingStep == 1`) redirect to the user's current step. The
 *     "current step" is `User.onboardingStep ?? 0`.
 *
 * The user MAY navigate backwards (e.g. `/onboarding/0` while on step
 * 2). Backwards navigation is non-destructive — the shell's "Back"
 * button uses it. Only forward jumps are blocked.
 */

const VALID_STEPS = [0, 1, 2, 3, 4] as const;
type Step = (typeof VALID_STEPS)[number];

export const dynamicParams = false;

export function generateStaticParams() {
  return VALID_STEPS.map((step) => ({ step: String(step) }));
}

interface PageProps {
  params: Promise<{ step: string }>;
}

export default async function OnboardingStepPage({ params }: PageProps) {
  const { step: stepParam } = await params;
  const parsedStep = Number.parseInt(stepParam, 10);

  if (
    !Number.isFinite(parsedStep) ||
    !VALID_STEPS.includes(parsedStep as Step)
  ) {
    notFound();
  }
  const requested = parsedStep as Step;

  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }
  const { user } = session;

  const completed = user.onboardingCompletedAt != null;

  // Completed users hitting any mid-flow step (1, 2, 3) are bounced
  // back to the dashboard — replaying half the wizard is never useful.
  // Step 0 stays accessible as the welcome-back surface (banner instead
  // of carousel) and step 4 stays accessible as the success screen so
  // a re-landing user has a clean "Open dashboard" exit.
  if (completed && requested > 0 && requested < 4) {
    redirect("/");
  }

  const current = clampCurrentStep(user.onboardingStep);
  if (!completed && requested > current) {
    redirect(`/onboarding/${current}`);
  }

  const locale = await resolveServerLocale({ userLocale: user.locale });
  const { t } = getServerTranslator(locale);

  // Welcome (step 0)
  //   * Fresh user → value-prop carousel.
  //   * Returning user (onboarding already completed) → welcome-back
  //     banner with "Open dashboard" CTA. The maintainer note 2026-05-14: the
  //     "restart onboarding" affordance lives in Settings → Account in
  //     v1.4.26; for now the banner is informational only.
  if (requested === 0) {
    return (
      <OnboardingShell step={0} userLocale={user.locale ?? null}>
        {completed ? (
          <section
            aria-labelledby="onboarding-welcomeback-title"
            className="space-y-4"
          >
            {/* Onboarding hero H1: intentionally semibold, not the app-wide bold PageHeader H1 (UI-STANDARDS §5 hero exception). Do not sweep to font-bold. */}
            <h1
              id="onboarding-welcomeback-title"
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight"
            >
              {t("onboarding.welcomeBack.title")}
            </h1>
            <p className="text-muted-foreground text-base leading-relaxed">
              {t("onboarding.welcomeBack.body")}
            </p>
            <div className="flex justify-end">
              <Button asChild size="lg">
                <Link href="/">{t("onboarding.welcomeBack.cta")}</Link>
              </Button>
            </div>
          </section>
        ) : (
          <WelcomeCarousel />
        )}
      </OnboardingShell>
    );
  }

  // Goals (step 1) — multi-select chip grid. Component owns its own
  // Back/Skip/Next row so the shell drops every footer href to avoid
  // duplicate controls. The user id is threaded as a prop so the
  // client hydration reads localStorage synchronously in its state
  // initializer (avoids the setState-in-effect anti-pattern).
  if (requested === 1) {
    return (
      <OnboardingShell step={1} userLocale={user.locale ?? null}>
        <GoalsChipPicker userId={user.id} />
      </OnboardingShell>
    );
  }

  // Source (step 2) — card grid. Manual is the implicit default; the
  // connectable sources (Apple Health, WHOOP, Oura, Polar, Nightscout,
  // Fitbit/Pixel via Google Health) live in `source-card-grid.tsx`'s
  // SOURCE_CARDS / MORE_SOURCES lists — refer to that component for the
  // current shipped set rather than duplicating it here. The selection
  // is non-binding: nothing here auto-configures a sync.
  if (requested === 2) {
    return (
      <OnboardingShell step={2} userLocale={user.locale ?? null}>
        <SourceCardGrid />
      </OnboardingShell>
    );
  }

  // Baseline (step 3) — profile form. PUT /api/auth/profile saves the
  // four fields, then POST step:4 advances + flips
  // `onboardingCompletedAt`.
  if (requested === 3) {
    return (
      <OnboardingShell step={3} userLocale={user.locale ?? null}>
        <BaselineForm />
      </OnboardingShell>
    );
  }

  // Done (step 4) — success screen + dashboard CTA. Reachable both
  // after first-completion (POST step:4) and again if a completed
  // user lands here by URL.
  return (
    <OnboardingShell step={4} userLocale={user.locale ?? null}>
      <DoneScreen />
    </OnboardingShell>
  );
}

function clampCurrentStep(value: number | null | undefined): Step {
  if (value == null || !Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  if (floor <= 0) return 0;
  if (floor >= 4) return 4;
  return floor as Step;
}
